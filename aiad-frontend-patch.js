/* AIAD front-end patch — 2026-08-24 */
(function () {
  'use strict';

  var sb = window.supabase || window.sb || window._supabase;
  if (!sb || typeof sb.from !== 'function') {
    console.warn('[aiad-patch] Supabase client not found — move this after createClient()');
    return;
  }
  if (window.__aiadPatchInstalled) return;
  window.__aiadPatchInstalled = true;

  /* 1. UUID guard — stops 22P02 "invalid input syntax for type uuid: undefined" */
  var UUID_COLUMNS = new Set([
    'actor','artist_id','brief_id','buyer_id','fan_id','follower_id',
    'following_id','id','listing_id','parent_id','post_id','product_id',
    'question_id','recipient_id','ref_id','session_id','statement_id',
    'supervisor_id','target','track_id','updated_by','user_id'
  ]);
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function isBadUuid(column, value) {
    if (!UUID_COLUMNS.has(column)) return false;
    if (value === null || value === undefined) return true;
    return typeof value === 'string' && !UUID_RE.test(value);
  }

  var builderProto;
  try { builderProto = Object.getPrototypeOf(sb.from('profiles').select('id')); }
  catch (e) { console.warn('[aiad-patch] no builder prototype', e); }

  if (builderProto && !builderProto.__aiadGuarded) {
    builderProto.__aiadGuarded = true;
    var origEq = builderProto.eq, origIn = builderProto.in, origThen = builderProto.then;

    builderProto.eq = function (column, value) {
      if (isBadUuid(column, value)) {
        this.__aiadShortCircuit = { column: column, value: value };
        return this;
      }
      return origEq.call(this, column, value);
    };

    builderProto.in = function (column, values) {
      if (Array.isArray(values)) {
        var clean = values.filter(function (v) { return !isBadUuid(column, v); });
        if (clean.length === 0 && values.length > 0) {
          this.__aiadShortCircuit = { column: column, value: values };
          return this;
        }
        return origIn.call(this, column, clean);
      }
      return origIn.call(this, column, values);
    };

    builderProto.then = function (onFulfilled, onRejected) {
      if (this.__aiadShortCircuit) {
        var accept = (this.headers && (this.headers.Accept || this.headers.accept)) || '';
        var isSingle = accept.indexOf('pgrst.object') !== -1;
        return Promise.resolve({
          data: isSingle ? null : [], error: null, count: 0, status: 200, statusText: 'OK'
        }).then(onFulfilled, onRejected);
      }
      return origThen.call(this, onFulfilled, onRejected);
    };
  }

  window.aiadCurrentUserId = async function () {
    try {
      var res = await sb.auth.getUser();
      var id = res && res.data && res.data.user && res.data.user.id;
      return UUID_RE.test(id || '') ? id : null;
    } catch (e) { return null; }
  };

  /* Re-run the view once auth resolves — the actual root cause */
  try {
    sb.auth.onAuthStateChange(function (event) {
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') {
        if (typeof window.renderRoute === 'function') { try { window.renderRoute(); } catch (e) {} }
        else if (typeof window.route === 'function') { try { window.route(); } catch (e) {} }
        else { window.dispatchEvent(new HashChangeEvent('hashchange')); }
      }
    });
  } catch (e) {}

  /* 2 + 3. Missing function shims */
  function shim(missingName, candidates) {
    if (typeof window[missingName] === 'function') return;
    window[missingName] = function () {
      for (var i = 0; i < candidates.length; i++) {
        var fn = window[candidates[i]];
        if (typeof fn === 'function') return fn.apply(this, arguments);
      }
      console.warn('[aiad-patch] ' + missingName + '() not defined — no-op');
    };
  }
  shim('loadSupportersData', ['loadSupporters','loadArtistSupporters','loadFanSupport','renderSupporters']);
  shim('_refreshInboxBadge', ['refreshInboxBadge','updateInboxBadge','setInboxBadge']);

  /* 4. usage_events — skip when logged out */
  window.aiadLogUsage = async function (event) {
    var uid = await window.aiadCurrentUserId();
    if (!uid) return;
    try { await sb.from('usage_events').insert(Object.assign({}, event, { user_id: uid })); }
    catch (e) {}
  };

  /* 5. Error card — correct window, production only */
  window.aiadErrorSummary = async function (hours, productionOnly) {
    var res = await sb.rpc('admin_error_summary', {
      p_hours: hours == null ? 24 : hours,
      p_production_only: productionOnly !== false
    });
    if (res.error) { console.warn('[aiad-patch] summary failed', res.error); return null; }
    return res.data;
  };

  /* 6. Drop non-bugs before they reach bug_reports */
  var BENIGN = [
    /PGRST303/i, /JWT expired/i, /\bLoad failed/i, /Failed to fetch/i,
    /NetworkError/i, /The operation was aborted/i, /AbortError/i,
    /42501\s*\|.*usage_events/i
  ];
  function isDevNoise(row) {
    var url = row && row.url;
    return url ? /localhost|127\.0\.0\.1|0\.0\.0\.0|:\d{4}\/index\.html/.test(url) : false;
  }
  function isBenign(row) {
    var text = [row && row.message, row && row.error_detail].join(' ');
    for (var i = 0; i < BENIGN.length; i++) if (BENIGN[i].test(text)) return true;
    return false;
  }

  var fromProto = Object.getPrototypeOf(sb.from('bug_reports'));
  if (fromProto && !fromProto.__aiadInsertGuarded) {
    fromProto.__aiadInsertGuarded = true;
    var origInsert = fromProto.insert;
    fromProto.insert = function (values, options) {
      var table = this.url && this.url.pathname ? this.url.pathname.split('/').pop() : null;
      if (table === 'bug_reports') {
        var rows = Array.isArray(values) ? values : [values];
        var keep = rows.filter(function (r) { return !isBenign(r) && !isDevNoise(r); });
        if (keep.length === 0) {
          var noop = Promise.resolve({ data: null, error: null, status: 200, statusText: 'OK' });
          noop.select = function () { return noop; };
          noop.single = function () { return noop; };
          return noop;
        }
        return origInsert.call(this, Array.isArray(values) ? keep : keep[0], options);
      }
      return origInsert.call(this, values, options);
    };
  }

  console.info('[aiad-patch] installed');
})();
