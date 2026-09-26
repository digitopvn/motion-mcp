# Research: ak-motion-video knowledge as a Motion MCP domain pack

Date: 2026-09-26. Sources: local installed skills under `C:\Users\admin\.claude\skills\` (ak-motion-video 1.2.0, ak-hyperframes 1.1.0, ak-motion-design 1.1.1, ak-motion-graphics 1.0.1) and upstream `bestagentkits/agentkit` (`kits/marketing/skills/ak-motion-video`).

## Bottom line

The skill is already about 70% of a domain pack. Its 61 style profiles use a strict schema: 14 closed dimensions, 19 scene types and required keys, all validated by `resolve-style.py`. It also has a deterministic layer-resolution algorithm and a fully scripted audio/timing pipeline. Motion MCP should lift the profiles and the resolver almost unchanged, keeping them as YAML with an index. It should also port the pipeline scripts as tools, not as prompt text. The only files that need real normalization work are the prose references (principles, rubric, antipatterns, pacing), which are spread across 4 skills. Licensing is clean: ak-motion-video and ak-motion-design are MIT, and ak-hyperframes is Apache-2.0. Keep the attribution headers.

## 1. Inventory

The local copy matches upstream byte for byte. All 90 upstream blobs have identical git hashes. The only local-only file is `scripts/__pycache__/*.pyc`. Upstream history has two commits, both dated 2026-09-26: `1ea04993` (skill added) and `e4069892` (style profiles and composition, #2055). The `agentkit` repo is private and reports no SPDX license. The skill ships its own MIT `LICENSE.txt` (BestAgentKits) and is vendored from the public MIT repo `bestagentkits/motion-video-skill` at sha `a73702b`.

| Area | Files (≈size) | Covers |
|---|---|---|
| `SKILL.md` | 8.9 KB | Scope, 6-step workflow, "Done when" gates, resource map |
| `references/production-pipeline.md` | 6.9 KB | Every command, from scaffold through render, remux, social encode and preview, plus a rebuild table |
| `references/audio-and-beat-sync.md` | 5.3 KB | Gemini TTS voice prompts, SFX cue anchors, ElevenLabs music plans, beat grid, bar-splice, mix targets |
| `references/composition-contract.md` | 5.1 KB | HyperFrames root/timeline, determinism, TIMING shape, helpers, scene windows, captions, mascot, renderer limits |
| `references/style-system.md` | 7.5 KB | 14 dimensions, 19 scene types, layer spec, 7 resolution rules, brand-alias policy |
| `references/styles/index.yaml` + `profiles/*.yaml` | 23 KB + 61 × ~3.6 KB | 61 styles: 20 aesthetic, 39 brand-inspired, 2 house |
| `references/style-{glass-keynote,comic-spiderverse,cinematic-product-launch}.md` | 3–6 KB each | Detailed tokens, layer stacks, components, captions and brand lock for the 3 reference styles |
| `scripts/*.py` | 24 KB | `resolve-style`, `fit-beat-grid`, `verify-arrangement`, `measure-mix-balance`, plus pytest tests |
| `assets/templates/` | ~45 KB | `index-skeleton.html`, 4 `.mjs` project scripts, 7 example data JSONs, `hyperframes.json` |

The three sibling skills contribute the following. ak-hyperframes covers the HTML schema (`data-*` attributes), the pinned CLI `hyperframes@0.8.77` and the render/cloud workflow. ak-motion-design, from LottieFiles, covers personality archetypes, duration/easing/stagger tables, the 1/3 rules, 4-act narrative, emotion mapping, a quality checklist and troubleshooting. ak-motion-graphics is a router plus verify helpers (`probe-mp4.sh`, `seek-shot.sh`, `contact-sheet.sh`, MIT from iart-ai).

## 2. Deterministic, reusable-as-code steps

Everything except creative choices and provider generation is deterministic and should become an MCP tool. Commands are run from the project directory.

- **Style lookup and resolution.** Run `python scripts/resolve-style.py find "<words>"`, then `resolve data/style.json --script data/script.json --json`, then `validate`, then `index --write`. The resolver works in this order: exact id, then alias, then base-for-all, then layers in listed order (last wins). Layer palettes add accents only unless `palette_mode: full` is set. It allows at most 4 layers and warns when more than 2 transition languages are used.
- **Audio generation.** This step calls non-deterministic providers but has a fixed argv. `multix gemini generate-speech --model gemini-3.8-flash-tts --voice <V> --style <S> --text <T> --output vo/<id>.wav` generates voice. `multix elevenlabs sfx --text <P> --duration-seconds <D> --prompt-influence 0.6 --output sfx/<id>.mp3` generates SFX. `multix elevenlabs music --plan data/music-plan.json --format mp3_44100_192 --output bgm-raw.mp3` generates music. Always run multix in a temp cwd, because it drops copies into `./multix-output`.
- **Forced alignment.** `multix elevenlabs align --input vo/<id>.wav --text <T> --output data/align/<id>.json` aligns each scene. The script then maps aligned words back to lines by token count and writes `data/vo-lines.json`.
- **Beat grid.** `python fit-beat-grid.py bgm-raw.mp3 --min-bpm 100 --max-bpm 130` is a brute-force fit that steps BPM by 0.02 and BEAT0 by 4 ms. It fits the 150 Hz low-band plus full-band onset envelope at 11025 Hz / hop 128 using ffmpeg, numpy and scipy (librosa hung on Windows, so it is not used). It prints BPM, BEAT0 and one row per bar with K/. kick marks and RMS dB.
- **Bar-splice arrangement.** `node arrange-music.mjs` builds an ffmpeg `atrim`/`afade`/`adelay`/`amix normalize=0` graph with 25 ms crossfades that end on the target downbeat and writes `bgm.flac`. `python verify-arrangement.py . --tolerance-ms 2` cross-correlates 2 s of each segment against its source and exits 1 on drift.
- **Timeline.** `node build-timeline.mjs [--dry|--no-audio|--stems]` does four things.
  - It schedules lines. Unanchored cuts land on the next beat at least 0.12 s after the previous voice. Lines are sped up with TEMPO 1.08 (outro lines are not). Segments get 0.08 s pre-roll and 0.15 s tail, clamped at the gap midpoint.
  - It times Vietnamese captions. Each VI word borrows the proportional EN word onset. Chunks hold at most 9 words and split at punctuation. A chunk starts 0.12 s before its first word.
  - It resolves SFX cues by word, beat, absolute time or scene offset.
  - It injects TIMING into `index.html` between `/*TIMING:BEGIN*/` and `/*TIMING:END*/`.
- **Mix.** Music runs at −5 dB into `sidechaincompress=threshold=0.03:ratio=3:attack=15:release=350:makeup=1`, keyed by the voice. Voice and SFX are each gained to −16 LUFS with peaks capped at −1 dBFS. The sum gets a 3.5 s fade, then two-pass `loudnorm=I=-14:TP=-1.5:LRA=11`, then AAC 192k 48 kHz into `mix.m4a`. A mono voice envelope at the frame rate (`TIMING.env`) drives mouths. `python measure-mix-balance.py .` reports music under speech against music in gaps (target: music ~5 dB under speech).
- **Validate and render.** Run `npx --yes hyperframes@0.8.77 lint`, then `check`, then `snapshot --at 2,18.5,40,… --describe false`. Render with `render -q high -f 30 --strict -o renders/<slug>.mp4`.
- **Remux** (required). `ffmpeg -y -i renders/<slug>.mp4 -i assets/audio/mix.m4a -map 0:v:0 -map 1:a:0 -c copy -movflags +faststart renders/out.mp4`.
- **QA probes.**
  - `ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,sample_rate,channels -show_entries format=duration <f>`
  - `ffmpeg -i <f> -af ebur128=peak=true -f null -` (expect about −14 LUFS, peak ≤ −1)
  - `ffmpeg -i <f> -vf blackdetect=d=0.1:pix_th=0.05 -an -f null -`
  - `probe-mp4.sh <f> 1920x1080 30`
- **Social encode.** `ffmpeg -y -i <master> -c:v libx264 -preset slow -crf 21 -maxrate 6M -bufsize 12M -pix_fmt yuv420p -profile:v high -level 4.1 -g 60 -c:a aac -b:a 192k -ar 48000 -movflags +faststart <social>.mp4`. On the comic edition this took 406 MB down to 101.6 MB with SSIM 0.977. Check quality with `ffmpeg -i social.mp4 -i master.mp4 -lavfi ssim -f null -`.
- **Runtime helpers** in `index-skeleton.html`: `B(n)`, `isKick`, `W/WE(sid, word, nth)`, seeded `rng`, `envKeys`, `pop/rise/slideX/flipIn/draw/typeIn/bump/odo/fadeOut`, `flash/shake`, the `WINDOWS` loop, and `on2` (comic stepping). These form a shared JS runtime that worker models should call rather than re-implement.

## 3. Proposed normalization

| Target file | Source sections | Representative entries (paraphrased) |
|---|---|---|
| `principles.md` | motion-design `core-philosophy`, `choreography`, `narrative-structure`, `disney-principles`; cinematic-launch "Design first"; contract "Determinism" | (1) One shot, one idea: if a scene needs "and", split it. (2) Choreograph on spoken words (`W()`), never on fixed offsets from the scene start. (3) Lead with the hero, and have every element enter from one shared origin. (4) Structure a sequence as setup (20–30%), action (30–40%) and resolution (30–40%), then 100–200 ms of stillness. (5) Cuts and drops carry the rhythm, while beat reactions stay subtle texture. (6) Every SFX needs a reason: a reveal, a state change or a landing. |
| `quality-rubric.yaml` | SKILL "Done when"; cinematic "Done when"; motion-design `quality-checklist` severity tiers; verify-loop | Hard gates: lint and check pass; splice lag within ±2 ms; music 4–6 dB under speech; 1920×1080 at 30 fps with AAC 48 kHz; −14 LUFS with TP ≤ −1; no black outside fades; no build-timeline warnings; facts traced to sources. Scored items: critical means linear ease on spatial motion or a stagger over 500 ms; high means wrong directional easing or no follow-through; style-specific checks include palette ≤3 tokens and ≤2 hard cuts for cinematic. |
| `shot-patterns.yaml` | style profiles `scene_types`, `signature_moves`, `ui_choreography`, `diagrams`; glass/comic "Components"; motion-design recipes | Stats: one huge number with a tiny label, digits slammed in with `odo`. Held reveal: the key element lands, then stays still for one beat or until `WE(word)`. Dashboard load: skeleton, then hero metric at 250 ms, then cards staggered 50 ms apart, then chart draw. Outro: drop the energy, slow line fade-ins, decelerating end card. Diagram: strokes drawn with `draw()` while packets travel along the SVG path. |
| `typography.yaml` | profile `typography` and `captions`; detailed style font lists; contract "Captions" | kinetic-typography uses Anton caps at 180–420 px with −0.01em tracking and 0.86 line height, plus one serif-italic emotional word per scene. cinematic uses Inter 600–700 with −0.03em tracking; do not bundle SF Pro. Captions use Be Vietnam Pro 600–800 at 40–46 px because it has full diacritics, in a bottom band ≤1660 px wide. Fonts are local OFL TTFs loaded with `font-display: block`. Use at most 3 typefaces. |
| `transition-patterns.yaml` | profile `transitions`; glass/comic "Motion language"; contract "Scene windows" | glass `up`: y 110→0, power3.out, 0.5 s. `iris`: clip-path circle 0→80%. comic `glitch`: RGB `feOffset` plus slice bars, 0.28 s. comic `dots`: halftone swell and shrink. cinematic `scale-through`: outgoing scene grows past camera while the incoming one settles from 1.04. `match-move`: the hero moves into its slot in the next scene. The out-transition matches the next window's kind, and no two neighbouring scenes share one. |
| `visual-antipatterns.yaml` | profile `avoid`/`constraints`; motion-design `troubleshooting`; contract "Renderer limits"; cinematic brand lock | More than ~40 live radial-gradient, blur or clip-path elements causes black frames, so bake them to PNG. CSS animations, rAF or `Date` break seeking. `repeat:-1` breaks timeline duration. Busy backgrounds behind type being read. Corner text or HUD chrome in premium styles. Opacity-only for important state changes. Brand logos, fonts or exact brand colours. |
| `pacing-patterns.yaml` | profile `pacing` and `beat_response`; cinematic BPM table; audio "Timeline anchors"; production budget | About 150 VO words per minute at TEMPO 1.08. BPM by mood: 60–80 regal, 90–110 smooth (the default), 115–123 elite. Feature scenes change every 2–4 beats; hero moments hold 8 or more. Put a silent stop (gap in the arrangement) before a drop for a shout line. Kick downbeats scale `#pulse` by about 1%. Drops get flash, shake and speed lines. |
| `style-profiles.yaml` | `styles/index.yaml` + 61 `profiles/*.yaml` + 3 `style-*.md` details | Keep per-profile files. The index keeps `id`, `aliases`, `energy`, `best_for`, `family`, `depth` and `summary`. Example: `cinematic-product-launch` (energy 2, alias Apple-like, prefers product-hero, avoids terminal/montage, pairs with premium-ui-demo). |

Put audio and mix rules in a ninth file, `audio-mix.yaml`, or in tool config rather than prompts. They are numbers the tools enforce, not guidance the director reasons over.

## 4. Retrieval keys

The skill's own schema already provides the right facets, so reuse them instead of inventing new ones.

- **`style_id`** plus **`dimension`** (one of the 14). Inject only the dimensions the resolver assigns to a scene, from the owning style. A worker building scene s07 gets, for example, `precision-dark-product.ui_choreography`, not the whole profile.
- **`scene_type`** (the 19-value enum) keys the shot patterns and the profile's `prefer`/`avoid` lists.
- **`role`** covers `director` versus `worker`. Directors get the index, principles, pacing and rubric summaries. Workers get the contract, helpers, the resolved dimension slices, the relevant transition entries and the antipatterns.
- **`format`** covers `landscape-1080`, `portrait-1080` and `square`. The current pack assumes 1920×1080 only, so tag layout and caption-band entries with the format they were measured for.
- **`energy`** (1–5) and **`personality`** (playful, premium, corporate, energetic) bridge the motion-design tables to the style profiles.
- **`invariant: true`** marks always-injected rules: the contract, determinism, caption band and renderer limits. Rule 6 of the resolver says these can never be overridden.
- **`pipeline_step`** (script, audio, align, grid, timeline, compose, validate, render) scopes QA and troubleshooting entries.

Do not load all 61 profiles. The index (~23 KB) is enough to choose one, and a resolved per-scene slice is roughly 1–2 KB.

## 5. Documented pitfalls

- **Timeline and GSAP.** Reusing a shared layer in `fromTo` without `immediateRender:false` leaks the start state to t=0. Infinite repeats break the length of the paused, seeked timeline. The timeline must end with `tl.set({}, {}, T.duration)`. All DOM must be built before the first tween. There are no CSS transitions.
- **Renderer.** Too many live gradients, blurs or clip-paths produce black frames. Attach SVG filters only while an effect runs. Use `visibility` rather than `opacity:0` on heavy full-frame layers. Lint warns above ~1000 lines but still renders. A composition without a timeline needs `data-no-timeline`, or it waits out a 45 s timeout.
- **Fonts.** Use local TTFs with `font-display: block`. Headless Chrome lacks platform fonts such as SF Pro. The verify-loop notes screenshots can be taken before fonts or lazy assets have painted.
- **Audio.** The renderer re-encodes AAC and pushed true peak to 0 dBFS, which is why the remux step is mandatory. If the first splice segment does not start at 0 s, `amix` re-bases the stream and shifts everything by 40 ms. ElevenLabs ignores per-section `duration_ms`, so fix drops by arranging, not by re-rolling. MiniMax Music returned HTTP 410. A −7 dB, ratio-5 duck left the music 10 dB under the voice, and viewers said "there is no music".
- **Alignment and captions.** A mismatch between `say` and `en` tokenization shifts every later line, reported as "N aligned words vs M tokens". Word lookups are lower-cased with punctuation stripped (for example `v334`). A missing `W()` word silently falls back to the scene start, with only a warning.
- **Platform.** On Windows, multix runs through `cmd.exe`, so `%` and `"` in spoken text must be escaped. librosa hangs on import on Windows.
- **Motion craft**, from motion-design troubleshooting: linear easing looks robotic; maxing everything out in energetic styles means nothing stands out; overshoot above 25% looks broken.

## Trade-offs and recommendation

Ranked:

1. **Lift and wrap.** Keep the profile YAML schema, the resolver and the scripts as-is behind MCP tools, and write only the 8 thin normalized files as indexes over them. This carries the lowest risk and keeps the pack diffable against upstream.
2. **Full re-authoring** into a single new schema. It is cleaner, but it forks from a skill that is only one day old and changing fast (two commits on 2026-09-26), and it throws away validation that already works.
3. **Prompt-injecting the raw skill docs.** This is simplest, but it costs the most tokens and gives worker models no enforceable gates.

Adoption risk is moderate. The pack pins `hyperframes@0.8.77`, `gsap@3.14.2` and `gemini-3.8-flash-tts`. It depends on the multix CLI and on provider accounts. It has only 3 styles with finished-edition detail; the other 58 profiles have never been rendered, and cinematic-product-launch has no demo.

## Limitations

- I did not run any script, render or test (`pytest scripts/tests`). I did not check the full `index-skeleton.html` body beyond its helper signatures, and I did not read all 61 profiles individually.
- The sibling skills (hyperframes, motion-design, motion-graphics) were not compared against upstream. Only ak-motion-video was.

## Unresolved questions

1. Will Motion MCP keep the multix/ElevenLabs/Gemini audio stack, or should the audio tools be provider-agnostic?
2. Are vertical (9:16) and square formats in scope? The caption band, the 1660 px width and the layout values are 16:9-specific.
3. Vietnamese karaoke captions and the "Zuey" signature are house defaults. Should they stay defaults or become options?
4. Can brand-inspired aliases (39 profiles) ship in a commercial product under the skill's no-logo/no-font policy, or does legal want them renamed?
