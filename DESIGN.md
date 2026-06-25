---
name: Riviso
description: AI-assisted content operations platform for SEO teams, agencies, and solo creators.
colors:
  ember: "#d97757"
  ember-deep: "#c86a4c"
  void: "#0b0b0d"
  void-elevated: "#121214"
  coal: "#1f1f1e"
  coal-elevated: "#262625"
  parchment: "#fbfbf8"
  parchment-cream: "#efede7"
  ink: "#141413"
  body: "#2c2c2a"
  dust: "#64625d"
  dust-soft: "#7a7872"
  on-dark: "#faf9f5"
  on-dark-soft: "#a09d96"
  success: "#5db872"
  warning: "#d4a017"
  error: "#c64545"
  white: "#ffffff"
typography:
  display:
    fontFamily: "Cormorant Garamond, ui-serif, Georgia, Times New Roman, serif"
    fontSize: "clamp(1.75rem, 4vw, 3rem)"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Inter, Geist Sans, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "normal"
  title:
    fontFamily: "Inter, Geist Sans, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "normal"
  body:
    fontFamily: "Inter, Geist Sans, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  label:
    fontFamily: "Inter, Geist Sans, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.02em"
  mono:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  pill: "9999px"
spacing:
  xxs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  xxl: "48px"
  section: "96px"
components:
  button-primary:
    backgroundColor: "{colors.ember}"
    textColor: "{colors.white}"
    rounded: "{rounded.sm}"
    padding: "10px 20px"
  button-primary-hover:
    backgroundColor: "{colors.ember-deep}"
    textColor: "{colors.white}"
    rounded: "{rounded.sm}"
    padding: "10px 20px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.on-dark}"
    rounded: "{rounded.sm}"
    padding: "9px 16px"
  button-ghost-hover:
    backgroundColor: "{colors.void-elevated}"
    textColor: "{colors.on-dark}"
    rounded: "{rounded.sm}"
    padding: "9px 16px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.on-dark-soft}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  nav-item-active:
    backgroundColor: "{colors.void-elevated}"
    textColor: "{colors.on-dark}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.void-elevated}"
    textColor: "{colors.on-dark}"
    rounded: "{rounded.lg}"
    padding: "{spacing.lg}"
  badge:
    backgroundColor: "{colors.void-elevated}"
    textColor: "{colors.on-dark-soft}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
---

# Design System: Riviso

## 1. Overview

**Creative North Star: "The Operations Room"**

Riviso is a tool for people who run content at scale. The interface reflects that: it lives almost entirely in dark mode — a matte, near-black void broken by precise typography, hairline borders, and the warm ember accent that marks every action worth taking. There is no decoration. Every element is load-bearing.

The tension that defines the system is between the analytical and the editorial. The UI chrome is sparse and purposeful — dense information, not cluttered. The only serif font (Cormorant Garamond) appears in article titles and display contexts, a quiet nod to the craft of the content being produced. Everything else is Inter: neutral, readable, unobtrusive at any size.

The system explicitly rejects the hyped startup aesthetic: no gradient text, no glassmorphism as default, no hero metrics dressed up with glow. It equally rejects the generic SaaS cream palette — there is no warm-tinted off-white canvas here. The workspace is dark because the work is concentrated. Where light mode appears (landing, auth, some nested panels), it uses parchment (#fbfbf8) — a true off-white with near-zero chroma, not a warm AI-default beige.

**Key Characteristics:**
- Dark-first: the project workspace and article editor default to dark mode (`#0b0b0d` void canvas)
- One accent: the ember orange (#d97757) is the single non-neutral color with semantic meaning — it marks every interactive and active state
- Flat with tonal depth: no decorative shadows; depth is achieved through surface opacity layering
- Compact density: 4px base grid, 14px default body text, information-rich panels
- Editorial/analytical hybrid: Cormorant Garamond for display contexts; Inter for all UI

## 2. Colors: The Void & Ember Palette

A near-monochromatic dark system anchored by one warm accent. The neutral ramp covers the full range from near-black void to off-white parchment; the ember is the only saturated color in the system.

### Primary
- **Ember** (#d97757): The single action color. Used on primary buttons, active nav states, interactive links, focus rings, progress fills, and inline accents. When something is orange, it means something.
- **Ember Deep** (#c86a4c): Pressed/active state for ember elements. Appears on `mousedown` and as the darker end of progress gradients.

### Neutral — Dark surfaces
- **Void** (#0b0b0d): The primary workspace canvas in dark mode. The most used background in the app.
- **Void Elevated** (#121214 / rgba(18,18,20,0.72)): Cards, panels, and modals sitting above the void. Often rendered with opacity for layering depth.
- **Coal** (#1f1f1e): Sidebar, header, and secondary surface in both light and dark contexts. Also the base dark surface in light-mode cards.
- **Coal Elevated** (#262625): Hover states on dark surfaces and nested panel backgrounds.

### Neutral — Light surfaces
- **Parchment** (#fbfbf8): Light-mode canvas and auth surfaces. True off-white, near-zero chroma.
- **Parchment Cream** (#efede7): Strong emphasis surface in light mode — used for highlight cards and loading panel backgrounds.

### Neutral — Text
- **Ink** (#141413): Highest-contrast text in light mode.
- **Body** (#2c2c2a): Default body text in light mode.
- **Dust** (#64625d): Muted text, labels, metadata in light mode. Dark mode equivalent: rgba(255,255,255,0.62).
- **On-Dark** (#faf9f5): Primary text on dark surfaces.
- **On-Dark Soft** (#a09d96): Secondary/muted text on dark surfaces.

### Semantic
- **Success** (#5db872): Positive states, published indicators, health checks.
- **Warning** (#d4a017): Caution states, indexing warnings, quota alerts.
- **Error** (#c64545): Destructive actions, validation failures, API errors.

### Named Rules
**The One Accent Rule.** Ember is the only non-neutral color in the system. It appears on ≤15% of any given screen. If two elements are both ember on the same view, one of them shouldn't be.

**The Dark-First Rule.** The primary application surfaces (project workspace, article editor) are dark mode by default. Light mode is for outward-facing and lightweight surfaces only. Do not fight this with light panels inside dark shells.

## 3. Typography

**Display Font:** Cormorant Garamond (with ui-serif, Georgia, Times New Roman fallback)
**Body Font:** Inter / Geist Sans (with system-ui, -apple-system fallback)
**Mono Font:** Geist Mono (with ui-monospace, SFMono-Regular, Menlo fallback)

**Character:** Cormorant Garamond is deployed surgically — it signals that what follows is content, not UI. Every time it appears, the context shifts from operating a tool to engaging with text. Inter handles everything operational: it is neutral, precise, and disappears at the correct size.

### Hierarchy
- **Display** (Cormorant Garamond, 400, clamp(1.75rem, 4vw, 3rem), 1.1 leading, −0.01em): Article titles in the editor, dashboard hero headlines. Never used for UI labels or buttons.
- **Headline** (Inter 500, 18px, 1.3 leading): Section headers, page titles, modal headings.
- **Title** (Inter 500, 15px, 1.4 leading): Card titles, widget headings, tab labels.
- **Body** (Inter 400, 14px, 1.55 leading): All interface copy, descriptions, article previews. Max line-length 70ch in reading contexts.
- **Label** (Inter 500–600, 11–13px, 0.02em tracking): Metadata, chips, status badges, column headers. Short strings only.
- **Mono** (Geist Mono 400, 12px, 1.5 leading): Terminal output, code snippets, log lines, URL display.

### Named Rules
**The Serif Boundary Rule.** Cormorant Garamond appears only where the context is genuinely about text content — article titles, editor display, reading surfaces. Never on navigation, buttons, form labels, or data tables. The serif is a content signal, not a brand brush.

**The No-Uppercase-Body Rule.** Uppercase is reserved for badge/chip labels (≤4 words) and the rare pipeline stage indicator. Never applied to sentences, paragraphs, or heading copy.

## 4. Elevation

The system is flat-by-default. Depth is achieved through tonal surface layering, not shadows. The `void` base sits beneath `void-elevated` cards which sit beneath modal panels — three surface tiers, all distinguished by background color alone.

Shadows appear only in two contexts: loading/generation overlays (where visual weight signals active computation) and the floating article generation panel (where it escapes page flow).

### Shadow Vocabulary
- **Overlay ambient** (`0 24px 70px rgba(20,20,19,0.18), 0 0 0 1px rgba(250,249,245,0.06) inset`): Loading panels and modal sheets. The inset ring creates a subtle framing edge.
- **Glow accent** (`0 0 26px rgba(204,120,92,0.18)`): Used sparingly on the loading ring and active generation spinner only. Not for cards or generic hover states.

### Named Rules
**The Flat-by-Default Rule.** Surfaces at rest are flat. Shadows are reserved for content that has physically escaped its container — modals, overlays, floating panels. A card inside a scrollable column does not need a shadow.

## 5. Components

### Buttons
Compact, purposeful. No large padding or theatrical hover effects.
- **Shape:** Gently rounded (6px, `--aa-r-sm`)
- **Primary:** Ember background (#d97757), white text, 10px/20px padding. Transitions to ember-deep (#c86a4c) on hover. `transition: background 0.15s ease, transform 0.1s ease`. Slight lift (`translateY(-1px)`) on hover.
- **Focus:** 2px solid ember offset 2px — visible focus ring, never suppressed.
- **Ghost / Secondary:** Transparent background, hairline border (`rgba(255,255,255,0.10)` on dark), on-dark text. Hover fills with void-elevated. Used for secondary actions and destructive confirmations.
- **Disabled:** Muted text (#757575), no pointer events, no hover treatment.

### Navigation (Sidebar)
- **Style:** Vertical sidebar, dark coal surface (`#1f1f1e`), hairline right border.
- **Default item:** On-dark-soft text, transparent background, 8px/12px padding, 6px radius.
- **Hover:** Coal-elevated background, on-dark text.
- **Active:** Void-elevated background, on-dark text, 3px left ember indicator strip (the single approved use of a left border — it is 3px, structural, and carries active-state information, not decoration).
- **Mobile:** Collapses to an off-canvas drawer triggered by a hamburger toggle.

### Cards / Containers
- **Corner Style:** Generously rounded (12px, `--aa-r-lg`) for top-level cards; 8px (`--aa-r-md`) for nested panels.
- **Background:** Void-elevated on dark canvas; parchment on light.
- **Shadow Strategy:** None at rest (flat). Overlay shadow only when floating above page flow.
- **Border:** 1px solid hairline (`rgba(255,255,255,0.10)` on dark; `rgba(117,117,117,0.10)` on light).
- **Internal Padding:** 24px (`--aa-s-lg`) default; 16px (`--aa-s-md`) for compact data panels.

### Inputs / Fields
- **Style:** Dark background (`rgba(255,255,255,0.04)`), 1px solid hairline border, 6px radius.
- **Focus:** Border shifts to ember with 0.15s transition. No glow; clean border change.
- **Placeholder:** On-dark-soft (#a09d96) at 60% opacity.
- **Error:** Border color shifts to error (#c64545); error message appears below in 12px label size, error color.
- **Disabled:** 40% opacity, no pointer events.

### Chips / Badges
- **Style:** Pill shape (`border-radius: 9999px`), semi-transparent ember background for active states (`rgba(204,120,92,0.16)`), hairline ember border (`rgba(204,120,92,0.28)`).
- **Text:** 11px, 700, 0.06em letter-spacing, uppercase.
- **Neutral variant:** Void-elevated background, on-dark-soft text, hairline border.

### Article Generation Panel (Signature Component)
The loading overlay that appears during article generation is the most visually expressive element in the system. It earns the exception: backdrop blur, a radial gradient glow behind the panel header, and animated concentric rings in ember + warning amber. This is the product's key moment of tension — the user is waiting for the thing they came to get. The motion and glow are purposeful, not decorative.

## 6. Do's and Don'ts

### Do:
- **Do** use ember (#d97757) on every primary button, active nav state, link hover, and focus ring — it is the action signal, and it should be consistent.
- **Do** keep the project workspace and article editor dark by default. The dark-first rule is not a theme preference — it is the primary context.
- **Do** use Cormorant Garamond only for article titles and genuine content display contexts. If in doubt, use Inter.
- **Do** achieve depth through surface-color layering (void → void-elevated → coal). Three tiers is enough.
- **Do** keep body text at 14px minimum and line length ≤70ch in reading contexts. Dense does not mean small.
- **Do** label every interactive element with a verb + object (`Publish article`, `Delete project`, not `OK` or `Yes`).
- **Do** provide explicit `:focus-visible` rings (2px solid ember) on every interactive element — never suppress them.
- **Do** pair color state changes with icons or text labels. Color alone is not sufficient for state communication.

### Don't:
- **Don't** use gradient text (`background-clip: text`). Ever. This is the clearest single signal of the hyped-startup aesthetic.
- **Don't** use glassmorphism (blur + semi-transparent card) as a default card style. The loading overlay earns it because it is the product's high-tension moment. Cards in scrolling content do not.
- **Don't** use side-stripe borders (`border-left` >1px in a non-ember color) as card accents or callout decorations. The active nav indicator is the sole approved left-border, and it uses ember.
- **Don't** introduce a second accent color. The system has one: ember. Adding purple, teal, or blue for a "feature" area breaks the one-accent doctrine and reads as inconsistency.
- **Don't** use Cormorant Garamond on UI labels, nav items, buttons, or form elements. The serif is a content signal, not a brand brush.
- **Don't** build a warm-tinted light-mode canvas. Parchment (#fbfbf8) is already at the warm edge; anything warmer will read as the generic SaaS-cream that Riviso is not.
- **Don't** put numbered section eyebrows (01 / 02 / 03) on every section of any marketing surface. Use numbered sequences only where the order carries real information.
- **Don't** build identical card grids (same icon + heading + text, repeated). Vary structure to vary emphasis.
- **Don't** animate layout properties or use bounce/elastic easing. Transitions are `ease` or `ease-out`. State changes are 150–200ms. Loading sequences may run longer but at constant speed.
