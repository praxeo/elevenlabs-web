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
      "ureterolithiasis", "biliary colic", "ureteral colic",
    ],
  },
  {
    id: "wound",
    label: "Wound care clinic",
    always: false,
    terms: [
      // Providers
      "Obert", "Siler", "Von Schweinitz", "Shapshak",
      "DeLaney", "Delaney", "Haverstock", "Passman",
      "Kelly", "Greene",
      // Cleansers & topical agents
      "Vashe", "Hibiclens", "Dakins", "Dakins quarter strength",
      "gentamicin ointment", "mupirocin", "triamcinolone",
      "nystatin", "bacitracin", "Flagyl",
      // Dressings — Hydrofera Blue
      "Hydrofera Blue", "Hydrofera Blue Ready", "Hydrofera Blue Classic",
      // Dressings — Aquacel
      "Aquacel Ag", "Aquacel AG ribbon", "Aquacel AG ribbon packing",
      // Dressings — Algidex
      "Algidex Ag", "Algidex AG hydrogel gauze",
      // Dressings — Mepilex
      "Mepilex", "Mepilex Border", "Mepilex Border Flex",
      "Mepilex Ag", "Mepilex Sacral",
      // Dressings — biological / enzymatic
      "Endoform", "Santyl", "NexoBrid", "EpiFix", "Resta",
      // Dressings — other
      "Triad", "Triad paste", "Cuticerin", "Xeroform",
      "Unna boot", "Profore", "Prisma", "Drawtex",
      "Xtrasorb", "Medipore", "Coban",
      "ABD pad", "lambswool", "skin prep",
      "white foam", "black foam", "wound vac foam",
      // Offloading & compression
      "TCC", "CROW boot", "Darco shoe", "diabetic shoe",
      "compression sleeve", "multilayer compression",
      "intermittent pneumatic compression",
      "lymphedema pump", "offloading",
      // Wound assessment
      "probe-to-bone", "undermining", "tunneling", "periwound",
      "granulation tissue", "hypergranulation", "epibole",
      "slough", "eschar", "fibrin", "serosanguineous", "maceration",
      "biofilm", "bioburden",
      "lipodermatosclerosis", "hemosiderin", "stasis dermatitis",
      "dorsalis pedis", "posterior tibial",
      "ankle-brachial index", "ABI", "wagner grade",
      // Debridement
      "sharp debridement", "mechanical debridement",
      "enzymatic debridement", "autolytic debridement",
      "selective debridement",
      // Diagnoses & conditions
      "osteomyelitis", "calcaneal osteomyelitis", "chronic osteomyelitis",
      "venous stasis ulcer", "diabetic foot ulcer", "DFU",
      "neuropathic ulcer", "pressure injury",
      "lymphedema", "venous insufficiency", "venous hypertension",
      "chronic venous insufficiency", "venous duplex",
      "fistula", "perianal fistula", "Crohn's disease",
      "hidradenitis suppurativa", "bullous pemphigoid",
      "pyoderma gangrenosum",
      "leukocytoclastic vasculitis", "LCV",
      "VEXAS syndrome", "Marjolin's ulcer",
      "paraplegia", "incomplete paraplegia",
      "spinal cord injury", "SCI",
      "hip disarticulation", "below knee amputation", "BKA", "AKA",
      "prosthetic joint infection",
      "metastatic breast cancer", "triple negative breast cancer",
      "DCIS", "soft tissue radionecrosis",
      "acute promyelocytic leukemia", "APL",
      "idiopathic pulmonary fibrosis", "IPF",
      "neurogenic bladder", "suprapubic catheter",
      "baclofen pump", "spasticity",
      "pilon fracture", "equinus deformity", "plantarflexion deformity",
      // Procedures & modalities
      "STSG", "NPWT", "HBOT", "HBO", "ATA", "TBICU",
      "THA", "TKA",
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
      // High-mangle-rate ER drugs (generic + brand) — added 2026-06-17
      "ondansetron", "Zofran", "ketorolac", "Toradol",
      "hydromorphone", "Dilaudid", "ceftriaxone", "Rocephin",
      "piperacillin-tazobactam", "Zosyn", "vancomycin",
      "enoxaparin", "Lovenox", "tranexamic acid", "TXA",
      "metoprolol", "diltiazem", "Cardizem", "labetalol",
      "levetiracetam", "Keppra", "naloxone", "Narcan",
      "epinephrine", "norepinephrine", "Levophed",
      "acetaminophen", "ibuprofen", "methylprednisolone", "Solu-Medrol",
      "famotidine", "Pepcid", "ipratropium", "albuterol", "DuoNeb",
    ],
  },
];
