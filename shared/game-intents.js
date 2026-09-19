// NPC buttons with literal choices. The server verifies the choice against a freshly
// rendered menu for an NPC in the character's actual location before calling it.
export const npcIntents=Object.freeze([
  'ismaelExchange','ismaelMakeCursed','ismaelCursedExchange','ismaelBuyAcc',
  'doBianAttr','doBianUncurse','toggleSherineWorld','toggleSherineMad',
  'hanAcceptQuest','hanSubmitProof','chooseMastery','startPrideClimb','sanctuaryEnter',
  'arkataBuyback','arkataRedeemItem','trial50Accept','trial50TurnIn','trial50Complete',
  'doIoExchange','doLachesisSplit','doYuriaExchange','shimizheEx','doYuriaHatinExchange','doRedExchange',
  'doDemonKingCraft','doLumielCraft','doMysticWandCraft','doSlayerCraft',
  'obelCancelTracking',
]);
