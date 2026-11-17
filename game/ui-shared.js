/* Constants and tiny helpers shared by the match modules. */

export const CANCEL = Symbol("cancel");
export const SVGNS = "http://www.w3.org/2000/svg";

export const PHASES = [
  ["untap", "Untap", ["untap"]], ["upkeep", "Upkeep", ["upkeep"]], ["draw", "Draw", ["draw"]], ["main1", "Main 1", ["main1"]],
  ["combat", "Combat", ["beginCombat", "declareAttackers", "declareBlockers", "combatDamage", "endCombat"]],
  ["main2", "Main 2", ["main2"]], ["end", "End", ["end", "cleanup"]],
];
export const STOP_KEYS = { upkeep: ["upkeep"], draw: ["draw"], main1: ["main1"], combat: ["beginCombat", "declareAttackers", "declareBlockers"], main2: ["main2"], end: ["end"] };
export const STEP_NAME = {
  untap: "Untap", upkeep: "Upkeep", draw: "Draw", main1: "Main phase 1", beginCombat: "Beginning of combat", declareAttackers: "Declare attackers",
  declareBlockers: "Declare blockers", combatDamage: "Combat damage", endCombat: "End of combat", main2: "Main phase 2", end: "End step", cleanup: "Cleanup",
};
export const STEP_NEXT = {
  main1: "to combat", beginCombat: "to attackers", declareAttackers: "to blockers", declareBlockers: "to damage", combatDamage: "to end of combat",
  endCombat: "to main 2", main2: "to end step", end: "to next turn", upkeep: "to draw", draw: "to main 1",
};
export const SPEED = { slow: 1.7, normal: 1, fast: 0.4 };

const P = (d) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + d + "</svg>";
const S = 'fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"';
export const IC = {
  lib: P('<rect x="6" y="3.5" width="12" height="16" rx="2" ' + S + '/><path d="M4 7v12.5A1.5 1.5 0 0 0 5.5 21H15" ' + S + "/>"),
  gy: P('<path d="M6 21V10a6 6 0 0 1 12 0v11z" ' + S + '/><path d="M12 8v6M9.5 10.5h5" ' + S + "/>"),
  ex: P('<circle cx="12" cy="12" r="7.5" ' + S + '/><path d="M12 4.5v15M4.5 12h15" ' + S + ' stroke-dasharray="2 3"/>'),
  menu: P('<path d="M4 7h16M4 12h16M4 17h16" ' + S + "/>"),
  log: P('<path d="M5 5h14M5 10h14M5 15h9M5 20h6" ' + S + "/>"),
  undo: P('<path d="M9 7 4 12l5 5M4 12h10a6 6 0 0 1 6 6" ' + S + "/>"),
  emote: P('<circle cx="12" cy="12" r="8.5" ' + S + '/><path d="M8.5 14.2c1.8 2 5.2 2 7 0M9 9.6v.6M15 9.6v.6" ' + S + "/>"),
  skip: P('<path d="M5 6l7 6-7 6zM13 6l7 6-7 6z" fill="currentColor"/>'),
  tools: P('<path d="M14.5 6.5a4 4 0 0 0 4.9 4.9L21 13l-3 3-1.6-1.6M3 21l9-9 3 3-9 9z" ' + S + "/>"),
  close: P('<path d="M6 6l12 12M18 6 6 18" ' + S + "/>"),
  eye: P('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" ' + S + '/><circle cx="12" cy="12" r="2.8" ' + S + "/>"),
  list: P('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" ' + S + "/>"),
  sword: P('<path d="M14.5 4.5 20 4l-.5 5.5L9 20l-5-5zM4 20l3-3M12 8l4 4" ' + S + "/>"),
  shield: P('<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z" ' + S + "/>"),
  plus: P('<path d="M12 5v14M5 12h14" ' + S + "/>"),
  minus: P('<path d="M5 12h14" ' + S + "/>"),
  check: P('<path d="m5 12.5 4.5 4.5L19 7" ' + S + "/>"),
  play: P('<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>'),
  star: P('<path d="m12 3 2.6 5.6 6 .8-4.4 4.2 1.1 6L12 16.7 6.7 19.6l1.1-6L3.4 9.4l6-.8z" fill="currentColor"/>'),
};

export const isMeaningful = (a) => !!a && !a.mana && a.type !== "special";
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
