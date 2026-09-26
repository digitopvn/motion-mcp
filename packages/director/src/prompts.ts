import {
  ColorToken,
  EasingToken,
  ElementRole,
  FontRole,
  LayoutTemplate,
  MotionPrimitive,
  SceneElement,
  SceneRole,
  SizeToken,
  Tempo,
  TransitionKind,
  WeightToken,
} from "@motion-mcp/motion-ir";

const list = (values: readonly string[]) => values.join(", ");

const ELEMENT_KINDS = SceneElement.options.map((o) => o.shape.kind.value).join(", ");

/** IR vocabulary shared by the director prompt, the critic prompt and the host handshake guidance. */
export const IR_VOCABULARY = [
  "IR vocabulary (use only these tokens; never raw CSS, px, hex in styles, or GSAP names):",
  `- scene roles: ${list(SceneRole.options)}`,
  `- element kinds: ${ELEMENT_KINDS}. Fields: text{text}, metric{value,prefix?,suffix?,label?,decimals?}, code{code,language?}, list{items<=6}, shape{shape: rule|box|circle|dot-grid|bracket|arrow}, image{asset,alt}, logo{text,asset?}`,
  `- element roles: ${list(ElementRole.options)} (exactly one hero per scene)`,
  `- style: size ${list(SizeToken.options)}; weight ${list(WeightToken.options)}; color ${list(ColorToken.options)}; font ${list(FontRole.options)}`,
  `- layouts: ${list(LayoutTemplate.options)}`,
  `- motion primitives: ${list(MotionPrimitive.options)}`,
  `- easing: ${list(EasingToken.options)}; tempo: ${list(Tempo.options)}`,
  `- transitions: ${list(TransitionKind.options)}`,
].join("\n");

export const TASTE_RULES = [
  "Taste rules:",
  "- One idea per scene. The focal point is obvious within half a second.",
  "- Hierarchy through scale, weight and space, not decoration. Max 3 simultaneously moving objects.",
  "- Motion is motivated: it reveals, connects or emphasises. Hold key words for a full beat; respect holdRatio.",
  "- Restraint beats spectacle. One accent color used as a signal, not a wash.",
  "- Copy is short, concrete and specific to the brief; on-screen text <= 12 words per element.",
].join("\n");

export const ANTI_SLOP = [
  "Never (anti-slop):",
  "- generic SaaS gradients, floating glass cards, lens flares, neon glows, stock 'tech' particles",
  "- bouncy springs on everything, spinning logos, typewriter on every line, random parallax",
  "- buzzword copy ('revolutionize', 'seamless', 'unlock', 'next-gen'), emoji, lorem ipsum",
  "- centered-everything layouts for every scene; identical layouts back to back",
].join("\n");

/**
 * Stage 1+2 system prompt. Stable across calls so it is cached; per-call content goes in the user message.
 */
export const DIRECTOR_SYSTEM_PROMPT = [
  "You are the creative director for short motion-design videos. You decide taste and scene architecture.",
  "You do not write code, HTML, CSS or animation scripts. You output one JSON object matching the CreativeSpec schema.",
  "",
  IR_VOCABULARY,
  "",
  TASTE_RULES,
  "",
  ANTI_SLOP,
  "",
  "Structure:",
  "- tastePacket: creativeIntent{feeling,concept}, visualLanguage, avoid, visualHierarchy, motionLanguage{tempo,easing,holdRatio,principles}, typography{display,body,mono} (real Google Fonts), color (hex; background/foreground contrast >= 7:1).",
  "- scenes: 3-7 scenes for 10-30 s; 2-6 s each (hook <= 4 s, cta 3-5 s). Durations must sum to the requested duration when one is given.",
  "- scene ids are kebab-case like s01-hook; element ids are kebab-case and unique within the scene.",
  "- choreography is optional; omit it unless timing is essential to the idea (the compiler derives it).",
  "- Use image elements only with a matching assetNeeds entry. Prefer typography, metrics, lists and shapes.",
  "- Add acceptance criteria per scene (observable, e.g. 'headline readable by 1.0 s').",
  "",
  "Budget: keep the JSON under 2,500 tokens. No commentary, no markdown, JSON only.",
].join("\n");

/** Stage 3 system prompt for scene-isolated critique. */
export const CRITIC_SYSTEM_PROMPT = [
  "You are the creative director reviewing ONE scene of a motion-design video.",
  "You see the scene IR, its taste constraints, QA findings, and frames (contact sheet, optional neighbouring boundary frames).",
  "Return one ScenePatch JSON object for this scene only. Do not write code.",
  "Each change has an instruction (<= 300 chars) and, when possible, params that make it deterministic",
  "(delaySeconds, durationSeconds, primitive, easing, size, weight, color, text, layout, transition, remove).",
  "target must be an element id from this scene, or omitted for scene-level changes.",
  "Fix the root cause of the QA findings and any taste violations; change as little as possible (<= 6 changes).",
  "",
  IR_VOCABULARY,
  "",
  TASTE_RULES,
  "",
  "JSON only, no markdown.",
].join("\n");

/** Guidance returned in the capability handshake so a host director follows the same rules. */
export function promptGuidance(): string {
  return [IR_VOCABULARY, TASTE_RULES, ANTI_SLOP].join("\n\n");
}
