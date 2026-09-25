# Sim Rate Panel

An EFB app for Microsoft Flight Simulator 2024. Pick a simulation rate from
0.25x to 32x, and see the rate the sim is actually running at — including
changes you made with a keybind, and changes the sim refused.

Eight preset buttons, a live readout, and a Reset to 1x. No keybinds to learn,
nothing to configure.

<p>
  <img src="screenshots/sim-rate-panel-open.png" alt="The Sim Rate panel open in the MSFS 2024 EFB, showing a 1x readout and the eight presets" width="360">
  <img src="screenshots/sim-rate-panel.png" alt="Sim Rate in the MSFS 2024 EFB app list" width="360">
</p>

*Left: the panel, with the current rate highlighted. Right: Sim Rate in the EFB app list.*

## Install

1. Download the release zip (or clone this repo).
2. Put the `sim-rate-panel` folder in your Community folder. On Steam that is
   `%APPDATA%\Microsoft Flight Simulator 2024\Packages\Community\`. The
   reliable way to find it on any install is to open `UserCfg.opt` and read
   `InstalledPackagesPath` — the Community folder sits inside it.
3. Restart the sim. Open the EFB; **Sim Rate** is in the app list.

Works on Linux/Proton — this package was developed and tested there.

## How it works

The readout is a mirror of the sim, not of your last tap. It reads
`E:SIMULATION RATE` every frame, so if you change the rate with a keybind, or
another add-on changes it, or the sim clamps it, the panel shows that within a
frame.

To change the rate it steps with the `SIM_RATE_INCR` / `SIM_RATE_DECR` key
events rather than `SIM_RATE_SET`, whose parameter convention is not documented
for this sim version — getting it wrong would set a wrong rate silently. After
each step it re-reads the rate and waits for the sim to actually move before
stepping again.

If the rate stops responding, the panel stops and tells you instead of retrying
forever. The sim refuses rate changes while paused, and caps the rate in
multiplayer.

## Known behaviour

- **Paused:** the sim refuses rate changes. The panel says so rather than
  appearing to do nothing.
- **Multiplayer:** the sim caps the rate (commonly at 4x). Tapping a higher
  preset walks up to the cap and then reports the refusal.
- **Leaving the app mid-change:** any in-flight change is dropped, so reopening
  the tablet never resumes a rate change you asked for earlier.

## Development

No build step, no dependencies, no bundler. The shipped app is three files under
`html_ui/efb_ui/efb_apps/SimRateApp/`; everything else here is tests and tooling.

```bash
node --test                   # 36 tests: ladder math, reducer, controller, EFB registration
node tools/build-layout.mjs   # regenerate layout.json + manifest total_package_size
```

Run the generator after changing any shipped file, then restart the sim — the
VFS reads `layout.json` at startup. Note that `node --test` also runs the
generator (via `test/build-layout.test.mjs`), so the tests rewrite `layout.json`
and `manifest.json` as a side effect.

Two conventions worth keeping if you edit the app:

- **The shipped files are pure ASCII**, with non-ASCII written as `\uXXXX`
  escapes, matching the sim's own EFB bundles. An escape and a literal are the
  same string at runtime, so the tests cannot catch a regression here —
  `grep -nP '[^\x00-\x7F]' html_ui/efb_ui/efb_apps/SimRateApp/SimRateApp.js`
  can.
- **`layout.json` keeps each file's real case.** The sim's own layouts are
  lowercased, which is fine on Windows, but Wine over ext4 can be
  case-sensitive and a lowercased entry then resolves to nothing.

## If the app does not appear

Turn on Dev Mode (Options > General > Developers) and check the console:

- `[EFB] App discovered : SimRateApp`, `[EFB] App folder registered : "..."` and
  `[EFB] App registered : "..."` are all **native** log lines from the sim's
  scanner — they fire before a single line of this app's JS runs. Any of them
  missing means the sim never found or registered the folder; check that
  `layout.json` lists the three files with their real case.
- A JS-side install failure (the script throwing) does not show up as a missing
  registration line — it surfaces as `console.error("App can't be installed", ...)`
  logged by the EFB's `Container.use`. That is the line to look for if all three
  native lines above appear but the icon still never shows up.

## License

MIT — see [LICENSE](LICENSE).
