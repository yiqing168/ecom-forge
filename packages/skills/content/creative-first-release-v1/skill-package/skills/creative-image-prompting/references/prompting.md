# Prompting Reference

Use this reference to decide image roles, visual priorities, and edit constraints. It is a decision aid, not a required prompt format.

## Specificity

- Detailed input: preserve its specificity and normalize only repetition, ambiguity, or order.
- Generic input: add tasteful scene, framing, polish, or material detail only when it materially improves the stated goal.
- Always keep the user's requested output type, exact text, key subject, and real exclusions.
- Do not add extra characters or objects, brand names, slogans, palettes, or narrative beats that are not implied.
- Do not use texture, mood, or quality adjectives to conceal an unresolved subject or composition decision.

## Prompt Structure

The strongest common progression is scene or visual field, subject, relevant details, then constraints. This is a helpful default, not a global ordering rule. A source-specific relationship can appear earlier when it is the main decision.

Include intended use when it changes the visual mode: editorial image, product photograph, interface mockup, poster, diagram, or illustration. Use camera and framing language for photorealism. Use material and mark behavior for print or drawn work.

## Reference Roles

For multi-image requests, identify each image by index and role. A source image may be an edit target, subject reference, style reference, composition reference, base scene, or insert. Say what evidence to take from it and what not to copy. For edits, repeat the important invariants on every revision so identity and layout do not drift.

## Exact Text

Quote visible copy verbatim. Include typography, placement, hierarchy, spacing, and contrast. Avoid additional wording. If the user did not request text, explicitly require a text-free image when invented lettering would be a likely failure.

## Self-Containment

- The renderer sees only the final direction plus the bound images, never the conversation. Restate subject, setting, palette, text, and constraints in full; never point at the chat.
- Banned pointers include "the above", "as mentioned", "same as before", "that feeling", and "keep it". Each is replaced by the concrete noun it stands for.

## Negatives

- Write negatives only against real failure modes of the current task ("No blue-dominant palette", "Do not combine multiple motion effects"), not generic filler.
- Combine related exclusions when that makes the direction clearer. There is no required number or category checklist.

## Execution Vocabulary

- Photography: lens and framing terms, light logic (softbox, golden hour, overcast diffusion), and real surface detail (pores, fabric wear, grain) instead of empty resolution words.
- Print: halftone density, ink overprint, uneven coverage, paper fiber, and slight misregistration instead of smooth gradients.
- Typography: quote copy verbatim with hierarchy, scale, placement, tracking, and contrast; when invented lettering is the likely failure, require a text-free image instead.

## Iteration

Inspect the result for subject fidelity, style, composition, text accuracy, and invariants. Make one targeted revision at a time. Name the one changed property and repeat the properties that must stay unchanged. A broad rewrite makes it harder to tell which decision caused the result to move.
