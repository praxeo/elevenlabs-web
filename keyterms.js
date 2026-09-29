// Deployer-curated keyterm lists, merged client-side with the user's custom
// terms on every dictation. Each list renders as a checkbox in the Keyterms
// section (checked ids persist per browser as `presetIds` in the v9
// settings). A list marked `always: true` would instead ride every dictation
// with no checkbox. None ships since 2026-09-29: the standard list was
// dropped after testing in WhisperInk showed Scribe v2 Medical doesn't need
// it. A dictation with nothing checked and no custom terms therefore sends
// no keyterms and pays no keyterm surcharge.
//
// Cost: any keyterms add ~20 %, and over 100 terms ElevenLabs bills each
// request as at least 20 s of audio (the wound care list alone is over 100).
// Terms must be < 50 chars and <= 5 words. If the 1000-term cap is hit, the
// user's custom terms win, then checked lists, then `always` lists.
// To add or edit a list: change this array and push to main (Workers Builds
// deploys it; the page is served no-store, so every device picks it up on
// its next load).
export const KEYTERM_PRESETS = [
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
      "hydromorphone", "Dilaudid", "ceftriaxone", "Rocephin", "TNKase", "thrombolytics", "Eliquis", "Xarelto", "GLP-1 agonist", "Mounjaro", "Ozempic",
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
