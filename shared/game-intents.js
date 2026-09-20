// NPC buttons with literal choices. The server verifies the choice against a freshly
// rendered menu for an NPC in the character's actual location before calling it.
export const npcIntents=Object.freeze([
  'ismaelExchange','ismaelMakeCursed','ismaelCursedExchange','ismaelBuyAcc',
  'doBianAttr','doBianUncurse','toggleSherineWorld','toggleSherineMad',
  'hanAcceptQuest','hanSubmitProof','chooseMastery','startPrideClimb','sanctuaryEnter','startOblivion',
  'enterRift','claimRiftReward','antharasEnter','antharasHelperAssign','antharasHelperRemove','startSiege',
  'arkataBuyback','arkataRedeemItem','trial50Accept','trial50TurnIn','trial50Complete',
  'doIoExchange','doLachesisSplit','doYuriaExchange','shimizheEx','doYuriaHatinExchange','doRedExchange',
  'doDemonKingCraft','doLumielCraft','doMysticWandCraft','doSlayerCraft',
  'obelCancelTracking',
  'magicDollSynth','exchangeSilverForBags','exchangeGoldForBoxes','openDollBag','openDollBox',
  'dollSynth','dollSynthAll','dollRerollT6','dollRerollT6All',
]);

// Map notices use the same interaction panel as NPCs, but are not DB.towns NPCs.
export const townEntrances=Object.freeze({
  _pride_entrance:Object.freeze({town:'town_pride',render:'renderPrideEntrance'}),
  _rift_entrance:Object.freeze({town:'town_rift',render:'renderRiftEntrance'}),
});

// Presentation flags only. Never copy browser timers or input state into the server.
export const journeyDefaults=Object.freeze({prideClimb:false,prideRanked:false,prideFloor:0,prideStartMs:0,
  riftRun:false,riftStartMs:0,riftBossDue:0,oblivion:null,antharas:0});
