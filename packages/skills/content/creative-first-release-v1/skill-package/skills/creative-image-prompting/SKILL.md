---
name: creative-image-prompting
description: 'Shape image generation and editing requests into clear, source-aware visual directions while preserving detailed user intent.'
---

# Image Direction Skill

Use this Skill when a task needs an image generated from a brief or an existing image edited. Decide two separate things first:

1. **Intent:** create a new image or change an existing image.
2. **Inputs:** which images are edit targets, visual references, or supporting material.

For every input image, state its role explicitly. An edit target supplies pixels and invariants to preserve. A reference supplies selected visual evidence such as style, composition, mood, or subject guidance. A supporting image supplies a deliberately chosen insert or compositing element. Do not blend several roles into an unnamed average.

## Prompt Shaping

Preserve the user's subject, intent, and explicit decisions, then author a strong visual interpretation. A detailed brief is not a command to write a flat transcription: resolve its tensions, select a point of view, and add original composition, visual metaphor, rhythm, atmosphere, material behavior, or spatial relationships when they make the requested image more distinctive. Do not invent factual source details, named brands, slogans, or unrelated subjects.

When useful, organize the final direction with this shared scaffold. It is a set of optional labels, not a closed schema or mandatory order:

```text
Use case: <visual purpose>
Asset type: <where or how the image is used>
Primary request: <the user's main request>
Input images: <Image 1: role; Image 2: role> (optional)
Scene/background: <environment or visual field>
Subject: <main subject and source evidence>
Style/medium: <photo, illustration, print, collage, or other medium>
Composition/framing: <viewpoint, scale, placement, and visual hierarchy>
Lighting/mood: <light logic and emotional register>
Color palette: <source-derived or requested colors and their roles>
Materials/textures: <surface and mark behavior>
Text (verbatim): "<exact approved text>" (optional)
Constraints: <what must remain or must happen>
Avoid: <negative constraints that protect the requested result>
```

The labels are scaffolding for clarity, not a demand to fill every field or follow a fixed order. Scene/background is visual content, not an output transparency setting. Let the visual idea determine the direction's length and density: remove procedural explanation, not the creative decisions needed to make visible pixels.

## Generate And Edit

Treat a request as an **edit** when the user wants to preserve parts of an existing image while changing something. State invariants explicitly before the change: identity, count, pose, expression, silhouette, key landmarks, spatial relationships, camera framing, and exact visible text when relevant. Then name the changed area and its visible consequence.

Treat a request as **generate** when images are only style, composition, mood, or subject references, or when no image is supplied. Preserve only the evidence the user asked to carry over; do not let a reference silently become a second subject or a full composition template.

For multiple outputs, each source-specific result needs its own visual decision. Separate calls or nodes are appropriate for distinct assets; a count is not a substitute for distinct directions.

## Visual Decisions

Describe relationships rather than stacking adjectives. “A small figure held by an open field, with the source horizon returning as a broken line” gives the image a decision; “minimal, poetic, premium” does not.

Choose a focal hierarchy, a spatial relationship, and when appropriate one dominant motion or material behavior. Seek one memorable visual proposition, then let secondary details reinforce it instead of turning the direction into a template. Use camera or viewpoint language for photographic work, and use material behavior that can actually be seen for print, collage, or illustration work.

Visible text must be quoted exactly and paired with hierarchy, scale, placement, tracking, and contrast. For difficult lettering, require verbatim rendering. If text is not requested, do not add labels, signatures, dates, coordinates, logos, pseudo-writing, or watermarks.

## Self-Contained Final Direction

The party that renders the image sees only the final direction plus the bound images. It never sees the conversation, so restate the visual decisions that would otherwise be lost. Replace ambiguous pointers such as "the above image" or "the same style as before" with the concrete source role or visual relationship when that distinction matters.

Ground identity, count, source-specific landmarks, exact copy, and other factual claims in observed evidence or the user's words. Creative interpretation is expected: the model may invent composition, metaphor, material behavior, atmosphere, and supporting form when they serve the requested result without falsifying source facts. Use negative instructions only for likely failure modes; do not turn every category into a repetitive prohibition list.

## Quality Check

Before finalizing, check that the subject, style, composition, text, and requested invariants are represented where relevant. Check that the first glance has a deliberate focal relationship, that the transformation is visible rather than merely named, and that factual claims do not drift from the source. Ask whether the image has a singular memorable idea, a controlled hierarchy, and enough visual specificity for the renderer to execute it. Remove procedural explanation, not creative substance.

Consult [references/prompting.md](references/prompting.md) when the request has ambiguous image roles, exact-copy requirements, or a difficult edit boundary. Consult [references/sample-prompts.md](references/sample-prompts.md) only when an example helps resolve a real composition choice. A clear request does not require either reference.
