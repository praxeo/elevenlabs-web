// Deployer-curated keyterm lists, merged client-side with the user's custom
// terms on every dictation. Lists marked `always: true` never appear in the
// UI and ride every dictation — which also means every dictation pays the
// ~20 % keyterm cost surcharge. The rest render as checkboxes in the
// Keyterms section (checked ids persist per browser as `presetIds` in the
// v9 settings). To add or edit a list: change this array and
// `npx wrangler deploy` — the HTML is served no-store, so every user gets
// the update on next load. Terms longer than 20 chars or 5 words are
// skipped by the realtime feed but still bias the batch/hybrid-refine call
// (< 50 chars there); when the realtime 50-term cap overflows, the user's
// custom terms win, then checked presets, then `always` lists.
export const KEYTERM_PRESETS = [
  {
    id: "standard",
    label: "Standard medical",
    always: true,
    terms: [
      "Cerner", "FirstNet", "PowerChart",
      "afebrile", "normocephalic", "auscultation",
      "alert and oriented", "no acute distress",
      "paronychia", "melena", "hematochezia", "HEART score", "MVC",
      "COPD", "nonspecific", "ascites", "syncopal", "CVA", "CABG",
      "ureterolithiasis", "biliary colic",
    ],
  },
  {
    id: "wound",
    label: "Wound care clinic",
    always: false,
    terms: [
      // Providers
      "Obert", "Siler", "Von Schweinitz", "Shapshak",
      "DeLaney", "Haverstock", "Passman",
      // Cleansers
      "Vashe",
      // Hydrofera Blue line
      "Hydrofera Blue", "Hydrofera Blue Ready", "Hydrofera Blue Classic",
      // Aquacel line
      "Aquacel Ag", "Aquacel AG ribbon",
      // Algidex line
      "Algidex Ag", "Algidex AG hydrogel gauze",
      // Mepilex line
      "Mepilex", "Mepilex Border", "Mepilex Border Flex",
      "Mepilex Ag", "Mepilex Sacral",
      // Other dressings
      "Endoform", "Triad", "Triad paste", "Cuticerin", "Xeroform",
      "Unna boot", "Profore", "Prisma", "Drawtex",
      "Xtrasorb", "Medipore", "Coban",
    ],
  },
  {
    id: "er",
    label: "ER shift",
    always: false,
    terms: [
      "troponin", "D-dimer", "lactate", "procalcitonin",
      "FAST exam", "CT angiogram", "pneumothorax", "pulmonary embolism",
      "aortic dissection", "subdural hematoma", "midline shift",
      "Glasgow Coma Scale", "obtunded", "diaphoresis", "syncope",
      "epigastric", "guarding", "rebound tenderness", "appendicitis",
      "cholecystitis", "diverticulitis", "pyelonephritis",
      "nephrolithiasis", "DKA", "diabetic ketoacidosis",
      "laceration", "avulsion",
    ],
  },
];
