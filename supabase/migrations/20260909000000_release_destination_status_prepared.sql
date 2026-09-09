-- A distributor pack is prepared, not delivered. 'pending' claimed AIAD had queued
-- something it never had; 'delivered' would claim it reached a DSP. Neither is true,
-- so the CHECK gains the state that is.
--
-- Widening only: every existing value stays legal and no row is rewritten.
alter table public.release_destinations
    drop constraint if exists release_destinations_status_check;

alter table public.release_destinations
    add constraint release_destinations_status_check
    check (status = any (array[
        'pending', 'prepared', 'submitted', 'delivered', 'live', 'taken_down', 'rejected'
    ]));
