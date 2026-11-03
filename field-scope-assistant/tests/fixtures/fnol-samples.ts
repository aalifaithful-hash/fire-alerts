// Fictional sample FNOL messages (no real customers) in the shapes FNOLs
// commonly arrive in: labeled dispatch blocks, Slack-style posts, and terse notes.

export const FNOL_EMS = `NEW LOSS - EMS
Claim #: WTR-2026-118842
Job #: 26-0417
Carrier: Sample Mutual Insurance
Insured: Jane Example
Phone: (212) 555-0142
Loss Address: 429 E 52nd St, Apt 5C, New York, NY 10022
Date of Loss: 11/02/2026
Type of Loss: Water - supply line burst under kitchen sink
Assignment Type: Emergency Services (water out, extraction, drying)
Received: 11/03/2026 7:42 AM`;

export const FNOL_MITIGATION_INITIAL = `*New assignment* :droplet:
Assignment Type: Water Mitigation
Visit: Initial walk-through
Claim Number - CC-77812-A
Customer: Mark Sample   Cell: 917-555-0199
Property Address: 1200 Grand Concourse #4B, Bronx, NY 10456
DOL: Oct 30, 2026
Cause of loss: Toilet overflow from unit above, ceiling and bathroom floor affected`;

export const FNOL_RECON = `Reconstruction assignment
Claim: RC-55120
Insured name: Sample Holdings LLC
Address: 88 W 3rd Street, Unit 2, New York, NY 10012
Loss date: 2026-09-14
Scope: Rebuild after mitigation completed by our crew. Drywall, baseboard, paint, LVP flooring.
Program: Sample Contractor Network`;

export const FNOL_CONTENTS_ONLY = `CONTENTS ONLY
Claim #: CN-30017
Owner: Rosa Example
Phone 646.555.0123
Location: 15 Example Pl, Brooklyn, NY 11201
Date of loss: 10/28/26
Description: Smoke from neighbor kitchen fire. Contents cleaning only — no structure work.`;

export const FNOL_FINAL = `Request: Final walk-through
Claim # WTR-2026-118842
Job #: 26-0417
429 E 52nd St Apt 5C New York NY
Mitigation complete, equipment pickup done Saturday. Customer available after 3pm.`;

export const FNOL_SPECIAL = `Assignment Type: Mitigation + Contents (pack-out)
Special Instructions: High-profile building — board approval required, elevator reservation 8am-4pm, COI on file before start.
Claim #: LL-90001
Insured: Example Co-op Board
Address: 1010 Fifth Avenue, Unit 12A, New York, NY 10028
DOL: 11/01/2026
Type of loss: Water from roof drain, large loss, 3 floors affected`;

export const FNOL_AMBIGUOUS = `Water leak at 77 Sample Rd. Not sure what they need yet, maybe initial inspection or final walk.`;
