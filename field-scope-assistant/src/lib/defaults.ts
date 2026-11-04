import { z } from "zod";

/**
 * EVERY professional default the app uses lives here — one editable file.
 *
 * At runtime these are the starting values; the Settings → Rules page stores
 * overrides in the database (per section), so any default can be changed in
 * the app without a code change, and "Reset" returns to the values below.
 * The plan doc (docs/PLAN-fnol-to-scope.md, "Defaults chosen") lists them.
 *
 * Basis: common Servpro / IICRC S500 (water) and S700/S520-style practice.
 * They are starting points for a PM to confirm, not engineering requirements.
 */

// ---------------------------------------------------------------------------
// 1. Cleaning / treatment methods by loss type
// ---------------------------------------------------------------------------
const CleaningRule = z.object({ label: z.string(), steps: z.array(z.string()) });
const CleaningMethods = z.object({
  water_cat1: CleaningRule,
  water_cat2: CleaningRule,
  water_cat3: CleaningRule,
  smoke_dry: CleaningRule,
  smoke_wet: CleaningRule,
  smoke_protein: CleaningRule,
  fire_char_nonporous: CleaningRule,
  fire_porous_heavy: CleaningRule,
  odor: CleaningRule,
});

// ---------------------------------------------------------------------------
// 2. "What goes with it" rules
// ---------------------------------------------------------------------------
const WhatGoesWithIt = z.object({
  baseboardRemoval: z.object({
    enabled: z.boolean(),
    sealPrimePaintFullWall: z.boolean(), // seal/prime + paint the full continuous wall to the natural break (wall SF)
    replaceBaseboard: z.boolean(), // new baseboard, LF on the same walls
    // (no "paint baseboard" option: the removed item is not repainted — the full wall is)
  }),
  flooringReplacement: z.object({
    enabled: z.boolean(),
    fullContinuousRun: z.boolean(), // replace the whole continuous run to the natural break
    reinstallBaseAndTransitions: z.boolean(), // detach & reset baseboard (LF) + transitions (EA) at openings
    detachResetFixtures: z.array(z.string()), // fixtures that sit on the floor and must be reset
  }),
  drywallFloodCut: z.object({
    enabled: z.boolean(),
    tapeFinishPrimePaintToBreak: z.boolean(),
    removeInsulationToCutLine: z.boolean(),
  }),
  cabinets: z.object({
    removeToeKickForDrying: z.boolean(),
    detachResetWhenFlooringReplaced: z.boolean(),
    reconnectPlumbingAndCountertop: z.boolean(),
  }),
  ceilingStain: z.object({ sealAndPaintFullCeiling: z.boolean() }),
  ceilingRemoval: z.object({
    enabled: z.boolean(), // removed ceiling drywall is replaced (same SF), then the full ceiling is painted
    replaceInsulation: z.boolean(),
  }),
});

// ---------------------------------------------------------------------------
// 3. Equipment ratios (always shown with the math; never an installed count)
// ---------------------------------------------------------------------------
const EquipmentRatios = z.object({
  airMoverSqFtMin: z.number().positive(), // 1 air mover per 50–70 SF of wet floor
  airMoverSqFtMax: z.number().positive(),
  dehuSqFtMin: z.number().positive(), // 1 LGR dehumidifier per 1,000–1,500 SF of affected space / chamber
  dehuSqFtMax: z.number().positive(),
  dehuDescription: z.string(),
  airScrubberPerAffectedArea: z.number().int().nonnegative(), // fire/smoke/odor or Cat 3
});

// ---------------------------------------------------------------------------
// 4. Flood-cut conventions
// ---------------------------------------------------------------------------
const FloodCut = z.object({
  marginAboveWetIn: z.number().nonnegative(), // 24" above highest waterline/wicking
  cat1LowWickingMarginIn: z.number().nonnegative(), // 12" option for Cat 1 with low wicking
  cat1LowWickingMaxWetIn: z.number().nonnegative(), // what counts as "low wicking"
  sheetStopsIn: z.array(z.number().positive()), // round the cut up to these heights (sheet efficiency)
  roundToSheetStops: z.boolean(),
});

// ---------------------------------------------------------------------------
// 5. Line-item format
// ---------------------------------------------------------------------------
const LineFormat = z.object({
  columns: z.array(z.string()),
  showRates: z.boolean(), // rates/totals are blank unless your pricing is configured
  categoryCodes: z.record(z.string(), z.string()), // optional house codes per line kind
});

// ---------------------------------------------------------------------------
// 6. Customer-preference exclusions
// ---------------------------------------------------------------------------
const Exclusions = z.object({
  contentsDeclinedText: z.string(),
  requireSignatureFor: z.array(z.string()),
  neverSilentlyDrop: z.boolean(),
});

// ---------------------------------------------------------------------------
// 7. Category-change flag (time/temperature degradation)
// ---------------------------------------------------------------------------
const CategoryChange = z.object({
  cleanToGrayAfterHours: z.number().positive(),
  grayToBlackAfterHours: z.number().positive(),
  alwaysCat3Sources: z.array(z.string()),
  alwaysAtLeastCat2Sources: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// 8. Program deadlines (FNOL receipt starts the timers)
// ---------------------------------------------------------------------------
const Program = z.object({
  name: z.string(),
  keywords: z.array(z.string()),
  contactWithinHours: z.number().positive(),
  onSiteWithinHours: z.number().positive(),
  estimateUploadWithinHours: z.number().positive(),
});

// ---------------------------------------------------------------------------
// Hazard / multi-unit / FNOL parsing / crew
// ---------------------------------------------------------------------------
const Hazards = z.object({
  leadBeforeYear: z.number().int(), // EPA RRP: homes built before 1978
  asbestosSurveyBeforeDemo: z.boolean(),
  asbestosNote: z.string(),
});

// ---------------------------------------------------------------------------
// Mold remediation (IICRC S520 practice; NY licensing). Starting points — the
// licensed assessor's protocol (mold report) governs and overrides them.
// ---------------------------------------------------------------------------
const MoldRules = z.object({
  /** Porous / semi-porous materials with growth are removed, not cleaned (S520). Matched against the material name. */
  removeWhenGrowth: z.array(z.string()),
  containment: z.object({ enabled: z.boolean(), description: z.string() }),
  negativeAirPerContainment: z.number().int().nonnegative(),
  dehumidifierPerContainment: z.number().int().nonnegative(),
  ppeDescription: z.string(),
  /** Cleaning sequence for structure left in place (subfloor, framing). */
  cleaningSteps: z.array(z.string()),
  antimicrobialAfterCleaning: z.boolean(),
  /** Remove baseboard to reach the edge of flooring being removed; wood baseboard in contact with growth is discarded. */
  removeBaseboardWithFlooring: z.boolean(),
  postRemediationVerification: z.boolean(),
  /** NY: projects above this area need a licensed assessor's plan, a licensed remediator and independent clearance. */
  licensedThresholdSF: z.number().nonnegative(),
  licensingNote: z.string(),
});

const FnolKeywords = z.object({
  mold: z.array(z.string()),
  ems: z.array(z.string()),
  mitigation: z.array(z.string()),
  reconstruction: z.array(z.string()),
  contents: z.array(z.string()),
  contentsOnly: z.array(z.string()),
  special: z.array(z.string()),
  initial: z.array(z.string()),
  final: z.array(z.string()),
  monitoring: z.array(z.string()),
  kickoff: z.array(z.string()),
});

export const RulesSchema = z.object({
  cleaningMethods: CleaningMethods,
  whatGoesWithIt: WhatGoesWithIt,
  equipment: EquipmentRatios,
  floodCut: FloodCut,
  lineFormat: LineFormat,
  exclusions: Exclusions,
  categoryChange: CategoryChange,
  programs: z.array(Program),
  hazards: Hazards,
  mold: MoldRules,
  fnolKeywords: FnolKeywords,
});
export type Rules = z.infer<typeof RulesSchema>;
export type RulesSection = keyof Rules;

export const DEFAULT_RULES: Rules = {
  cleaningMethods: {
    water_cat1: {
      label: "Category 1 (clean water)",
      steps: ["Extract standing water", "Dry structure in place", "Clean affected hard surfaces"],
    },
    water_cat2: {
      label: "Category 2 (gray water)",
      steps: [
        "Extract standing water",
        "Remove porous materials in contact (e.g. carpet pad)",
        "Apply antimicrobial to affected surfaces",
        "Clean remaining affected surfaces",
      ],
    },
    water_cat3: {
      label: "Category 3 (black water)",
      steps: [
        "Extract standing water",
        "Remove porous materials in contact (carpet, pad, drywall, insulation)",
        "Flood cut affected walls",
        "Apply antimicrobial to affected surfaces",
        "Evaluate affected contents for disposal (customer sign-off)",
      ],
    },
    smoke_dry: { label: "Dry smoke", steps: ["HEPA vacuum", "Dry chemical sponge"] },
    smoke_wet: { label: "Wet smoke", steps: ["Degreaser wet-clean"] },
    smoke_protein: { label: "Protein smoke", steps: ["Degreaser clean", "Odor control"] },
    fire_char_nonporous: { label: "Heavy char/soot on non-porous surfaces", steps: ["Clean"] },
    fire_porous_heavy: { label: "Porous materials with heavy deposits", steps: ["Seal (stain-blocking primer) or remove"] },
    odor: { label: "Odor", steps: ["HEPA air scrubber", "Deodorization as needed"] },
  },
  whatGoesWithIt: {
    baseboardRemoval: { enabled: true, sealPrimePaintFullWall: true, replaceBaseboard: true },
    flooringReplacement: {
      enabled: true,
      fullContinuousRun: true,
      reinstallBaseAndTransitions: true,
      detachResetFixtures: ["toilet", "vanity", "appliances"],
    },
    drywallFloodCut: { enabled: true, tapeFinishPrimePaintToBreak: true, removeInsulationToCutLine: true },
    cabinets: { removeToeKickForDrying: true, detachResetWhenFlooringReplaced: true, reconnectPlumbingAndCountertop: true },
    ceilingStain: { sealAndPaintFullCeiling: true },
    ceilingRemoval: { enabled: true, replaceInsulation: true },
  },
  equipment: {
    airMoverSqFtMin: 50,
    airMoverSqFtMax: 70,
    dehuSqFtMin: 1000,
    dehuSqFtMax: 1500,
    dehuDescription: "LGR dehumidifier, ~70–130 pints/day (AHAM)",
    airScrubberPerAffectedArea: 1,
  },
  floodCut: {
    marginAboveWetIn: 24,
    cat1LowWickingMarginIn: 12,
    cat1LowWickingMaxWetIn: 6,
    sheetStopsIn: [12, 24, 48, 96],
    roundToSheetStops: true,
  },
  lineFormat: {
    columns: ["Activity", "Item", "Quantity", "Unit", "Rate", "Total", "Notes / Justification"],
    showRates: false,
    categoryCodes: {},
  },
  exclusions: {
    contentsDeclinedText:
      "Contents cleaning and pack-out excluded at the customer's request ({date}, decided by {decidedBy}). This scope covers the structure only; contents remain the customer's responsibility.",
    requireSignatureFor: ["contents_cleaning", "contents_packout", "contents_all", "room", "service_line"],
    neverSilentlyDrop: true,
  },
  categoryChange: {
    cleanToGrayAfterHours: 48,
    grayToBlackAfterHours: 72,
    alwaysCat3Sources: ["sewage", "toilet_with_feces", "flood", "groundwater"],
    alwaysAtLeastCat2Sources: ["toilet_overflow", "dishwasher", "washing_machine", "sump_pump"],
  },
  programs: [
    { name: "Default program", keywords: [], contactWithinHours: 1, onSiteWithinHours: 4, estimateUploadWithinHours: 24 },
  ],
  hazards: {
    leadBeforeYear: 1978,
    asbestosSurveyBeforeDemo: true,
    asbestosNote:
      "Asbestos survey/clearance required before demolition where local rules apply (e.g. NYC requires an asbestos investigation before most demolition).",
  },
  mold: {
    removeWhenGrowth: ["carpet", "pad", "wood", "hardwood", "engineered", "laminate", "parquet", "underlayment", "drywall", "insulation", "ceiling tile"],
    containment: { enabled: true, description: "6 mil poly containment with zipper door, sealed seams and decon/entry chamber" },
    negativeAirPerContainment: 1,
    dehumidifierPerContainment: 1,
    ppeDescription: "PPE: disposable coveralls, half/full-face respirator with P100 cartridges, gloves, eye protection",
    cleaningSteps: ["HEPA vacuum", "Wire-brush / sand remaining growth", "HEPA vacuum", "Damp-wipe"],
    antimicrobialAfterCleaning: true,
    removeBaseboardWithFlooring: true,
    postRemediationVerification: true,
    licensedThresholdSF: 10,
    licensingNote:
      "NY: mold work over 10 SF needs a licensed mold assessor's remediation plan, a licensed remediation contractor (not the assessor) and independent post-remediation clearance (NYS Labor Law Art. 32). NYC buildings with 10+ units: Local Law 61 work practices.",
  },
  fnolKeywords: {
    mold: ["mold", "mould", "microbial", "mold remediation", "mold scope", "fungal growth"],
    ems: ["ems", "emergency service", "emergency services", "emergency mitigation", "emergency response", "water out", "board up", "board-up", "24 hour emergency"],
    mitigation: ["mitigation", "water mitigation", "dry out", "dryout", "drying", "extraction", "wtr", "dehu", "remediation"],
    reconstruction: ["reconstruction", "rebuild", "recon", "build back", "build-back", "repairs", "structural repair", "restoration repair"],
    contents: ["contents", "content cleaning", "contents cleaning", "pack out", "pack-out", "packout", "contents manipulation"],
    contentsOnly: ["contents only", "content only", "contents-only", "cleaning only"],
    special: ["special assignment", "special project", "special handling", "special instructions", "large loss", "high profile", "vip", "catastrophe", "cat event"],
    initial: ["initial walk-through", "initial walkthrough", "initial walk through", "initial inspection", "initial assessment", "initial visit", "first visit", "new loss"],
    final: ["final walk-through", "final walkthrough", "final walk through", "final inspection", "final walk", "fwt", "completion walk", "closeout"],
    monitoring: ["daily monitoring", "monitoring", "moisture check", "daily check", "check readings"],
    kickoff: ["kickoff", "kick-off", "kick off", "start work", "production start"],
  },
};

/** Deep-merge a stored override over the defaults (arrays/records replace wholesale). */
export function mergeRules(overrides: Partial<Record<RulesSection, unknown>>): Rules {
  const merged: Record<string, unknown> = { ...DEFAULT_RULES };
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in DEFAULT_RULES) || v == null) continue;
    const base = (DEFAULT_RULES as Record<string, unknown>)[k];
    merged[k] = deepMerge(base, v);
  }
  const parsed = RulesSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_RULES;
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (Array.isArray(over) || typeof over !== "object" || over === null) return over;
  if (typeof base !== "object" || base === null || Array.isArray(base)) return over;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  return out;
}

/** Validates one section edited on the Rules page. */
export function validateSection(section: RulesSection, value: unknown) {
  return RulesSchema.shape[section].safeParse(value);
}

export const RULE_SECTION_LABELS: Record<RulesSection, string> = {
  cleaningMethods: "Cleaning methods by loss type",
  whatGoesWithIt: "What goes with it",
  equipment: "Equipment ratios",
  floodCut: "Flood-cut conventions",
  lineFormat: "Line-item format",
  exclusions: "Customer-preference exclusions",
  categoryChange: "Category-change flag",
  programs: "Program deadlines",
  hazards: "Hazard checks",
  mold: "Mold remediation (S520 / NY licensing)",
  fnolKeywords: "FNOL keywords (parser)",
};
