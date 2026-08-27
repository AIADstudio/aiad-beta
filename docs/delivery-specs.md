# AIAD Delivery Specifications

Technical standards for audio and artwork on the AIAD Streaming Layer.

## Audio

### Accepted
Format — WAV (preferred) or FLAC.
Bit depth — 24-bit preferred, 16-bit minimum.
Sample rate — 44.1 kHz minimum; 48 kHz and 96 kHz accepted.
Channels — Stereo. Mono accepted if the recording is genuinely mono — do not fake-stereo a mono file.
Max file size — 500 MB per track.

MP3, M4A, AAC, and OGG are rejected. Delivering a lossy file means AIAD transcodes an already-transcoded file and the artifacts compound. Upload the master.

### Levels
True peak ceiling: −1.0 dBTP. Anything above is rejected for clipping.
Target loudness: −14 LUFS integrated. This is guidance, not a gate — AIAD normalizes on playback, so a hot master just gets turned down and loses dynamics. Nothing is rejected on loudness alone.
No inter-sample clipping.

### Rejected on QC
Audible clipping, digital distortion, or dropouts. More than 5 seconds of silence at the start. Producer tags, DJ drops, or watermarks not part of the released work. Audible watermarking from a beat lease preview. Files that are the wrong length versus the stated duration.

## Artwork

### Required
Dimensions — 3000 × 3000 px minimum, perfectly square.
Format — JPG or PNG. Color — RGB. Max file size — 10 MB. Resolution — 72 DPI minimum.

### Rejected on QC
Any URL, web address, email, or social handle. Any social platform or streaming service logo or name. Text that is blurry, pixelated, cropped, or unreadable. Misspelled artist name or release title. Artist or release name that doesn't match the metadata. Images you don't have the rights to — including stock photos without a license, celebrity photos, and screenshots. Placeholder or temporary artwork. Nudity or sexually explicit imagery.

Artwork must be square. AIAD will not crop, pad, or resize on your behalf — a 1920×1080 image comes back as a rejection, not a letterbox.

## Metadata formatting
These rules exist so search, playlists, and credits stay usable across the catalog.

Do: Title Case for titles, e.g. "Nothing Left to Say". Featured artists in the dedicated field — primary "Artist Name", featured "Other Artist". Version info in parentheses — "Nothing Left to Say (Acoustic)". Real legal names in the songwriter fields, because stage names break PRO matching.

Don't: ALL CAPS unless the work is genuinely stylized that way. "(feat. X)" typed into the title field. "(Official Audio)", "(Official Video)", "(Lyrics)", "(HD)", "(Prod. by X)" anywhere in the title. Emojis or decorative characters. Genre or mood keywords stuffed into the title. The same ISRC on two different recordings — including a remaster, which needs its own.

## Turnaround
QC review — 1–3 business days.
Minimum lead time before go-live — 3 business days.
Recommended lead time — 7 days, so a rejection doesn't move your date.
Takedown from Streaming Layer — within 7 days of request.
Cache purge after takedown — within 30 days.

## Storage
Masters are stored in AIAD's private storage. They are served to fans as encoded streams only — the original file is never exposed at a public URL and is never downloadable by anyone but you.
