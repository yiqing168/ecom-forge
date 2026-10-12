import {
  parseCreativeDirectionSelection,
  type CreativeDirectionSelection,
  type CreativeDirectionProfileId,
} from '@ecom-forge/shared';
import { z } from 'zod';

export const creativeDirectionSelectionSchema = z.custom<CreativeDirectionSelection>(
  (value) => parseCreativeDirectionSelection(value) !== null,
  'Unsupported creative direction selection or version',
);

// Published v1 definitions are immutable. Add a version instead of editing their methods.
const profilesV1: Readonly<Record<CreativeDirectionProfileId, string>> = {
  'human-story':
    'Human story: Notice revealing gestures, relationships, traces of activity, and the moment before or after an event. Build a specific tension between intention and circumstance. Give a small observed detail a consequential role; a surprising reversal or understated joke can carry the story. Decide which visible moment lets the viewer infer the rest. Favor meaningful action over posed figures or a caption explaining an absent event.',
  'visual-metaphor':
    'Visual metaphor: Notice a particular contour, rhythm, function, or relationship in the available evidence. Find an unexpected second meaning that preserves a recognizable link to that evidence. Reverse a use, change a scale, or make a figurative relationship physically visible. Commit to one legible transformation and specify what makes it work in this image. Favor a discoverable connection over unrelated surreal objects or a stock symbol.',
  'spatial-drama':
    'Spatial drama: Read viewpoint, depth, occlusion, negative space, and relative scale. Develop tension through an unexpected spatial relationship: a shift of viewpoint, a revealing overlap, a scale reversal, or a boundary becoming consequential. Choose a focal relationship the eye can follow, then specify its geometry and visual result. Respect fixed source pixels and identity. Favor purposeful spatial surprise over an arbitrary distortion or impossible clutter.',
  'color-expression':
    'Color and form: Read existing color relationships, silhouettes, light-dark masses, and visual rhythm. Translate the desired feeling into one strong relationship of hue, shape, contrast, or repetition. Explore an unexpected balance or interruption, then choose what the eye should feel first. If colors or source pixels are fixed, express the idea through permitted surrounding form, rhythm, and contrast. Favor a purposeful emotional structure over a fashionable palette or indiscriminate saturation.',
  'graphic-order':
    'Graphic order: Identify the single visual claim, the hierarchy needed to read it, and which detail can become an unmistakable sign. Explore bold omission, an unexpected alignment, a scale contrast, or a productive break in repetition. Organize the image around that decision while preserving required information. Use typography only when the task permits it. Favor a memorable visual proposition over a generic grid, extra labels, or merely neat decoration.',
  'material-experiment':
    'Material experiment: Observe actual surface, thickness, flexibility, reflection, transparency, tension, and contact. Build an unexpected use or transformation from a material property supported by the evidence. Choose a moment of folding, revealing, resisting, transmitting, or changing state; specify the contact and visible consequence. Respect factual product materials and protected source pixels. Favor a tactile, intelligible discovery over ornamental texture, arbitrary tearing, or a showcase of many effects.',
};

const creativeBoundary =
  'Apply this lens only to creative decisions left open by the current user request and Skill. Their explicit constraints, source fidelity, product facts, identity, and host tool policy remain authoritative. For ordinary conversation, answer the question normally. For an edit, carry out the requested change and preserve the established work elsewhere. Ground invention in the actual evidence. Be ambitious in the central idea and precise in the visible relationships; render the idea rather than the persona name. Do not add a role label or extra caption to the image.';

const profilesV2: Readonly<Record<CreativeDirectionProfileId, string>> = {
  'human-story':
    'Human story: Find the gesture, interval, relationship or trace that makes this particular moment matter. Decide what the viewer can infer about intention and circumstance from visible evidence. Develop tension through timing, distance, an understated reversal or a consequential detail, not merely by including people. Make the selected moment and its consequence readable without explanatory copy; do not invent a biography or event to support it.',
  'visual-metaphor':
    'Visual metaphor: Find a specific correspondence in contour, function, rhythm or relationship, then decide what second meaning it can carry. Develop one discoverable connection through the transformations the brief permits. Specify the shape, placement, contact or absence that makes both readings visible. Calling something like a wave, mirror or symbol is not a transformation by itself; the geometry must carry the connection without the metaphor label. Keep the link specific to this source or brief.',
  'spatial-drama':
    'Spatial drama: Find the consequential distance, viewpoint, overlap, boundary or scale relationship. Decide how the permitted composition can make that relationship newly felt, rather than just reducing a subject against empty space. Specify how focal elements, depth cues and occupied or unoccupied areas affect one another, so the eye can follow the tension. A quiet interval can be as forceful as a dramatic perspective; choose from the evidence, not a default horizon or distortion.',
  'color-expression':
    'Color and form: Find the expressive conflict or affinity between existing color masses, silhouettes, light-dark values and rhythm. Decide which relationship should carry the feeling, and how its balance, interruption, edge or repetition becomes visible. Stronger color is not necessarily stronger expression, and more scenery is not more invention. Preserve required color facts and source pixels; use only the form and contrast the brief leaves open. Keep typography and secondary detail in their task-defined hierarchy.',
  'graphic-order':
    'Graphic order: Decide the single visual proposition the viewer should recognize and the evidence that makes it specific. Explore how omission, alignment, relative scale, an interval or a break in repetition can turn that proposition into a memorable sign. Build hierarchy around the selected relationship, not a reusable grid with a different subject. Preserve required information and text policy; typography can support the idea when permitted, but must not replace an unexpressed visual claim.',
  'material-experiment':
    'Material experiment: Find the relevant behavior of surface, thickness, tension, reflection, transparency or contact. Decide what an allowed material action can reveal, resist, transmit or transform, and specify the contact and visible consequence that makes the idea intelligible. Texture alone is not an experiment. Respect factual materials and protected pixels; if literal transformation is forbidden, develop the permitted representation of their behavior rather than pretending a product changed material.',
};

const conceptDevelopmentV2 =
  'For open-ended creation, compare interpretations that differ in their central relationship or meaning, not just color, line weight or detail. Choose one source- or brief-specific visual proposition with a visible payoff; a simple faithful solution may win when it serves the task best. During prompt authoring, carry that decision into concrete image-model instructions: what relates to what, how it is arranged or transformed, and what the viewer will see. An operational plan is not a visual template. Establish this relationship before letting surface style dominate; preserve the Skill text policy and hierarchy. Keep alternatives internal, with no fixed number, output template, extra model call or extra image. During repairs, retain the chosen proposition unless the reported issue invalidates it.';

const creativeBoundaryV2 =
  'User instructions, Skill constraints, source facts, identity, protected pixels and host tool policy remain authoritative. Reinterpret only where the task allows it; do not confuse preserving facts with copying every compositional choice into a new artwork. A narrow edit must stay within its requested scope, with no forced novelty or redesign elsewhere. For ordinary conversation, answer normally. Render the idea, not the persona name, and add no role label or extra caption. Changing ink, adding scenery or describing ambition does not substitute for a meaningful decision.';

export function formatCreativeDirectionContext(value?: CreativeDirectionSelection): string {
  if (value === undefined) return '';
  const selection = creativeDirectionSelectionSchema.parse(value);
  if (selection.mode === 'native') return '';
  if (selection.mode === 'auto' && selection.version === 3) {
    return `<creative_direction>\nAutomatic session policy v3. Do not choose a designer for ordinary chat. When proposing the first image plan, observe the selected image inputs first, then choose exactly one dominant lens from the six IDs below and set creative_direction_profile_id on agent_candidate_plan. The host will lock that method v2 for this session, including authoring, repairs and later turns. Choose by the creative opportunity, not subject categories. A fixed method is not a fixed layout.\nhuman-story: a revealing moment and consequential relationship.\nvisual-metaphor: a specific correspondence with two visible readings.\nspatial-drama: a consequential distance, viewpoint, boundary or scale.\ncolor-expression: expressive tension or affinity of color, form and rhythm.\ngraphic-order: a memorable visual proposition through hierarchy and omission.\nmaterial-experiment: material behavior made visible through contact and consequence.\n${conceptDevelopmentV2}\n${creativeBoundaryV2}\n</creative_direction>`;
  }
  if (selection.version === 2) {
    const lens =
      selection.mode === 'profile'
        ? `Selected lens: ${selection.profile_id}@2.\n${profilesV2[selection.profile_id]}`
        : [
            'Automatic creative direction policy v2. Select one dominant lens from the opportunity in this request and its allowed freedom, not subject categories. Keep the selected proposition coherent across planning, per-source authoring, repairs and recovery; give each independent source its own specific interpretation. A lens changes the way an idea is developed, not a fixed style or layout.',
            'human-story: a revealing moment and consequential relationship.',
            'visual-metaphor: a specific correspondence with two visible readings.',
            'spatial-drama: a consequential distance, viewpoint, boundary or scale.',
            'color-expression: expressive tension or affinity of color, form and rhythm.',
            'graphic-order: a memorable visual proposition through hierarchy and omission.',
            'material-experiment: material behavior made visible through contact and consequence.',
          ].join('\n');
    return `<creative_direction>\n${lens}\n${conceptDevelopmentV2}\n${creativeBoundaryV2}\n</creative_direction>`;
  }
  const lens =
    selection.mode === 'profile'
      ? `Selected lens: ${selection.profile_id}@${selection.version}.\n${profilesV1[selection.profile_id]}`
      : [
          'Automatic creative direction policy v1. After understanding the request and observing available evidence, choose one dominant lens for this turn. Select by the creative opportunity and allowed freedom, not by subject categories. Keep it coherent with the established plan and completed drafts across authoring and repairs. A lens is a way of developing an idea, not a fixed visual style.',
          'human-story: revealing action, relationships, tension, humor.',
          'visual-metaphor: specific visual correspondences, changed meaning or use.',
          'spatial-drama: viewpoint, depth, scale, occlusion, spatial surprise.',
          'color-expression: expressive relationships of hue, form, light and rhythm.',
          'graphic-order: hierarchy, omission, alignment, a strong visual sign.',
          'material-experiment: evidence-based material behavior, contact and transformation.',
        ].join('\n');
  return `<creative_direction>\n${lens}\n${creativeBoundary}\nTranslate the chosen idea into concrete image-making decisions in the final creative prompt. Give each source its own observed detail and consequence.\n</creative_direction>`;
}
