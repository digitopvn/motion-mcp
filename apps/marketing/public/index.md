# Motion MCP: describe a video, get a finished film

> Motion MCP gives your AI assistant a real motion studio. You write one sentence. It directs, builds and renders the MP4. Open source (MIT). Every new account starts with 5,000 free credits; no credit card.

- Website: https://motion.digitop.ai/
- Dashboard and sign-up: https://app.motion.digitop.ai
- MCP endpoint: https://app.motion.digitop.ai/mcp
- Source (MIT): https://github.com/digitopvn/motion-mcp
- Agent reference: https://motion.digitop.ai/llms.txt

## Intro film

An 84-second intro, made with the same motion-video skill that runs under the hood: https://motion.digitop.ai/media/intro.mp4

## Showcase: six briefs, six films

Each film was made from the one-line brief below. The brands are made up; the renders are untouched pipeline output.

| Film | Format | Genre | Brief |
|---|---|---|---|
| [launch.mp4](https://motion.digitop.ai/media/launch.mp4) | 16:9, 9.5 s | Product launch | "Launch teaser for Quiet Hours, a focus timer app. Calm, editorial, a little smug about silence." |
| [kinetic.mp4](https://motion.digitop.ai/media/kinetic.mp4) | 9:16, 8.2 s | Social reel | "Nobody reads the manual, so make it move. Loud, playful." |
| [bakery.mp4](https://motion.digitop.ai/media/bakery.mp4) | 4:5, 9.5 s | Local ad (Vietnamese) | "Quảng cáo lớp làm bánh mì chua cuối tuần. Ấm áp, gần gũi, tiếng Việt." |
| [data.mp4](https://motion.digitop.ai/media/data.mp4) | 16:9, 9.0 s | Data story | "A data story about developer coffee habits. Deadpan humor, dark editorial charts feel." |
| [event.mp4](https://motion.digitop.ai/media/event.mp4) | 1:1, 9.0 s | Invitation | "Square invite for a year-end company party. Elegant, with a wink." |
| [explainer.mp4](https://motion.digitop.ai/media/explainer.mp4) | 16:9, 9.5 s | Explainer | "Technical explainer: how one MCP call turns a brief into a finished video. Blueprint feel." |

## How it works: a film crew in one sentence

1. **You write the brief.** Plain words are enough, in English or Vietnamese.
2. **The director sets the taste.** A top model (Claude Opus) decides story, pacing, type and color. It is only called when taste matters, and it never writes code.
3. **The crew builds every scene.** Code and small, fast models turn the plan into scenes. A producer model (Jev) decides who fixes what, and whether a fix is worth paying for.
4. **The editor checks, then renders.** Every scene is checked frame by frame before the final render. You get a web-ready MP4 and a share link.

## Why it is different

| Topic | Typical AI video | Motion MCP |
|---|---|---|
| Text on screen | Melted letters, creative spelling | Real typography, spelled right every time |
| Changing one thing | Regenerate everything and hope | Say what to change; only that scene is rebuilt |
| Your brand | Colors that are "close enough" | Exact colors, clean type, same result every render |
| Cost | A big model on every step | A big model only for taste; code does the chores |
| What happened | A black box | Every step and its cost, visible in the dashboard |

## Connect your assistant

1. Sign in to the dashboard and create an API key.
2. Add this block to your assistant's MCP settings (Claude Code, Cursor, VS Code and other MCP clients).
3. Ask for a video in your own words.

```json
{
  "mcpServers": {
    "motion": {
      "type": "http",
      "url": "https://app.motion.digitop.ai/mcp",
      "headers": { "Authorization": "Bearer mmcp_YOUR_API_KEY" }
    }
  }
}
```

No assistant? Type the brief straight into the dashboard.

The dashboard shows your credit balance, credits held by running jobs, recent usage, your videos, API keys and the setup snippet on one page: [screenshot](https://motion.digitop.ai/media/dashboard.webp).

## Pricing

- One credit is one US cent. A budget cap stops any job before it overspends.
- About 32 credits per 10-second sample when your assistant writes the creative plan (host-opus).
- About 130 credits when you send only a brief and our director plans it (internal-opus adds 100 credits).
- Early access: every new account starts with 5,000 free credits. Paid top-ups come later.

## FAQ

**Do I need to know how to code or edit video?** No. Describe the video in plain words, to your AI assistant or in the dashboard.

**What kinds of videos can it make?** Motion graphics: launch teasers, explainers, social reels, data stories, invitations and announcements, in 16:9, 9:16, 1:1 or 4:5. It composes text, shapes, numbers and code on screen. It does not film people or generate photoreal footage.

**What if I don't like the result?** Say what to change. Only the affected scenes are rebuilt.

**Can I download and post the videos?** Yes. Every final render is a web-ready MP4 you can download or share through a stable link.

**Can I run it on my own servers?** Yes. The stack is open source under the MIT licence. Bring your own model keys; billing can be switched off.
