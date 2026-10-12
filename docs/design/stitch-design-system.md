# 象塑 Stitch Design System

This file is the single source of truth for visual design tokens used by every document under `docs/design/`. Page prompts may describe composition and state, but must not redefine sizes, typography, color, radius, or shell dimensions differently.

## Product Character

象塑 (Xiangsu) is a Chinese e-commerce AI creation workbench. Its brand description is “重塑物象，万千风格”. It should feel like a focused creative studio for producing product images, not a generic enterprise dashboard, a content community, or a marketing landing page. The interface should be composed, capable, and direct: the current product, reference image, prompt, and generated result are always more important than decoration.

The 2026-10-10 light-style update applies directly to the existing product UI. It must preserve all menu names, ordering, routes and behavior; there is no separate preview application. Reference Jimeng's light surfaces and visual density without copying its navigation or product features. See `05-xiangsu-light-style-update.md`.

## Layout

- Desktop reference is 1440 x 900. Content must be readable at that size, not designed as a sparse 2560px poster.
- Use a 128px compact left product rail and a 64px top utility bar. Every rail item pairs an icon with a 14px Chinese text label. The current 1A rail remains “创作 / 生成 / 资产 / 作品”; Account remains pinned at the bottom. Mobile retains the same four entries and “我的”. Future stages do not add entries as part of a style update.
- The A04 conversation-history rail is 280px wide when expanded and is hidden or collapsed in the visitor/new-session state.
- Standard page content uses a 1120-1200px working width. Do not shrink important work areas to a narrow column surrounded by empty space.
- A04 is a creation workbench: a central composer is the first visual focus. It is 960-1060px wide, substantial in height, and visually anchored above concise creation starters.
- Conversation history and task detail are on-demand drawers, never permanent competing dashboard columns on a new session.
- Canvas is a separate full-screen professional workspace. Do not add canvas controls to normal product pages.

## Typography

- Assistant Markdown uses an unframed reading surface: 15px body / 28px line height, 12px paragraph gaps, 16-18px headings and normal letter spacing. Use semantic foreground, muted, border and surface tokens. Lists retain visible markers; quotes use a single border; tables and code scroll within their own width. Streaming and history share the same renderer, with no additional reply cards. Reference review: local `imgage/` layout references and supplied Jimeng conversation screenshots; retain the 1A conversation product shape.

- Use Noto Sans SC, PingFang SC, Microsoft YaHei, or comparable Chinese UI typography. Chinese is the primary language.
- Headline: 32-40px, semibold, normal letter spacing. It should orient the user, never read like a landing-page slogan.
- Section title: 20-24px. Body uses 16px as its baseline and never drops below 15px. UI labels are 14px minimum. 12-13px is reserved for non-essential metadata with sufficient contrast; essential actions and errors never use microcopy.
- Use near-black text for primary content and neutral gray for metadata. Do not use low-contrast gray for interactive labels.

## Color and Depth

- Background: cool light gray #F7F9FB. Surface: #FFFFFF. Ink: #202328. Muted text: #626A73. Borders: #E8ECF0 and #DCE2E7.
- Primary action: near-black #20282D with #343E44 hover. Teal #007C72 marks brand and focus, with #E8F3F1 selected surfaces and #006C63 selected text. Restrained coral #C64F43 is for errors; teal #087B75 supports informational/success semantics; amber #B56A18 is reserved for warnings, credits and cost.
- Implementation maps every visual color through semantic CSS variables in `apps/web/app/globals.css`. Product components must not contain raw hex values. Soft status surfaces, focus rings, inverse surfaces, and canvas colors are named semantic tokens derived from the palette above; adding a new semantic color requires updating this document first.
- Colors indicate intent, not decoration. Ordinary links, labels, and body copy remain near-black instead of becoming blue.
- Use 1px low-contrast borders and restrained tonal separation. Use only subtle shadows on overlays and hoverable media, never glassmorphism, blur, gradients, neon, or decorative orbs.

## Visual Anti-Patterns

- Do not wrap every section or row in a bordered white card, and never nest decorative cards. Use whitespace, full-width tonal bands, dividers, typography, and image scale to establish hierarchy. A card is reserved for a discrete interactive object, modal, or genuinely framed tool.
- Do not use a thick colored side border as a generic emphasis device. Costs, warnings, progress, and errors use their semantic token together with clear text and status treatment.
- Do not place low-contrast gray text on colored surfaces. Text on semantic surfaces must use a foreground token that meets the required contrast; muted neutral text remains valid for metadata on neutral surfaces.
- Avoid a flat, untinted gray-only interface. Near-black ink and neutral grays remain part of the system, but surface and neutral choices must preserve the product's cool-warm balance and semantic hierarchy.
- Do not use bounce or elastic easing. Motion must be short, restrained, and purposeful, using transform and opacity where possible; layout-property animation requires an explicit interaction reason and browser verification.
- Do not place familiar icons inside decorative rounded-square tiles. Use the icon directly in a correctly sized button or control, with an accessible name and tooltip when its meaning is not obvious.

## Components

- Maximum corner radius is 8px. Avoid pill-shaped cards. Pills are reserved for compact tags and status chips.
- Primary buttons are solid near-black with concise Chinese action text. Secondary controls are quiet outlined or text actions.
- Composer controls are grouped by their role: source material, context, generation settings, then send. Do not divide every item with vertical lines or give each item identical visual weight.
- An attachment appears as a thumbnail with a role label. `@` only references attachments in the current input area.
- Product/SKU is not a fixed control in the creation-home composer. When the Agent identifies an e-commerce task, it may ask for product context in the conversation or open the product flow; if a product is already bound by an explicit entry action, show it as a compact removable chip, never as a table embedded in the composer.
- Example starters are four editorial product-image tiles with scene labels. They are creation shortcuts, not a community feed or a card grid.

## Imagery

- Use bright, inspectable e-commerce product photography: apparel, footwear, home, beauty, and daily goods. Products must be the subject, not blurred lifestyle atmosphere.
- Image tiles must have varied but coherent product categories. Do not duplicate the same generated stock image across tiles.
- Do not use competitors' branded assets or reference screenshots as production imagery.

## Exclusions

- No admin dashboard KPI cards, fake sales metrics, tables on the creation home, marketing hero copy, membership campaigns, countdowns, or empty feature placeholders.
- No independent login page as the default first screen. The visitor begins in A04 and authentication opens when they attempt to submit.
- No canvas-first layout, agent chain-of-thought, tool JSON, internal states, or hidden automatic fee confirmation.

## Required A04 Visitor State

- Top: New session, Help, Login.
- Center: Chinese creation prompt with source attachment, Agent selector (智能生图 Agent / 智能视频 Agent), Skill selector, and a clear Start Creating action. Product/SKU is introduced only by an explicit e-commerce context, not as a default picker.
- When 智能生图 Agent is selected, show compact image settings for ratio and output count. When 智能视频 Agent is selected, show compact settings for 720P/1080P, ratio, duration, and output count. Output count combines common shortcuts with an editable positive integer; an explicit count in the prompt is synchronized into the current turn instead of being ignored. Keep these controls grouped at the lower edge of the composer and do not turn them into a form.
- Below: White-background retouch, product hero image, style transfer shortcuts, then four example creation starters.
- Send when unauthenticated opens an auth overlay, preserves the draft, and never silently sends after login.

## Automated Design Review

- Impeccable `3.5.0` is pinned as an advisory rendered-page detector. Start the web app first, then run `pnpm design:detect` for the 1440x900 desktop report and `pnpm design:detect:mobile` for the 390x844 mobile report; their `:json` variants provide machine-readable output.
- `pnpm design:detect:source` remains available as a lightweight source regex scan. It cannot resolve React composition, computed styles, responsive layout, contrast, overlap, or runtime state, so an empty source report must never be described as a passed UI review.
- Rendered URL scans currently cover `/` only. Other routes and authenticated states remain part of the Playwright screenshot and flow review until a reviewed multi-route runner is added. URL scans require the local server at `127.0.0.1:3000` and an available Chromium browser.
- Generated builds, dependencies, reports, and local runtime artifacts are excluded through `.impeccable/config.json`. Inter is the only shared value waiver because it is the reviewed Latin companion font; no detector rule is globally disabled.
- The detector does not replace this document, product research, desktop/mobile screenshot review, Playwright flows, or user acceptance. It is intentionally excluded from `pnpm check` until several review cycles establish an acceptable false-positive rate.
- Rule suppressions require a narrow value or file scope and a written reason. Do not disable a rule merely to make the report green.
- The 2026-08-09 source baseline found the attachment stack's width transition and a legacy cost card that is no longer part of the product. The first rendered baseline additionally found example-image hover scaling and a translucent top-bar contrast warning. The card was removed and the remaining issues were resolved without rule waivers.
