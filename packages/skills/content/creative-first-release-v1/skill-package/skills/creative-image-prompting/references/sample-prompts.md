# Copyable Prompt Patterns

These patterns are intentionally short and must be adapted to the actual source. They are not fixed templates.

## Photorealistic Natural

```text
Use case: photorealistic-natural
Primary request: candid editorial photograph of [subject and action]
Scene/background: [place and environmental context]
Subject: [observable identity and material details]
Style/medium: photorealistic candid photography
Composition/framing: [viewpoint, distance, and focal placement]
Lighting/mood: [natural light direction and restrained mood]
Materials/textures: [skin, fabric, surface, or environmental texture]
Constraints: natural color balance; no heavy retouching; no watermark
Avoid: staged look; studio polish unless requested
```

## Minimal Editorial Transformation

```text
Use case: stylized-concept
Input images: Image 1: edit target and semantic source
Primary request: create one complete editorial artwork from the source
Subject: preserve [count, pose, silhouette, identity, and source-specific landmark]
Style/medium: [chosen medium and material behavior]
Composition/framing: [new scale relationship and visual hierarchy]
Color palette: [source-derived anchor color] with [background] and [structural dark]
Constraints: change [requested transformation] only; keep [invariants] recognizable; no extra text or watermark
Avoid: generic template; unrelated objects; decorative clutter
```

## Precise Edit

```text
Use case: precise-object-edit
Input images: Image 1: edit target
Primary request: change only [specific area or object]
Constraints: preserve [identity, count, camera angle, lighting, shadows, layout, and surrounding objects]; match the existing perspective and material; no extra elements or text
```

## Identity-Preserving Edit

```text
Use case: identity-preserve
Input images: Image 1: person or subject target; Image 2: selected visual reference
Primary request: change only [requested property]
Constraints: preserve face, body shape, pose, expression, hair, defining marks, and identity; match lighting and shadows; keep unrelated areas unchanged; no accessories or text unless requested
```

## Review

- Is the request visibly executable, rather than merely descriptive?
- Does the prompt preserve the source evidence that makes the image recognizable?
- Is the image role for every input explicit?
- Are exact words separated from mood and optional atmosphere?
- Are avoid items limited to likely failures?
