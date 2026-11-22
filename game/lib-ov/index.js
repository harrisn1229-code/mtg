// lib-ov/index.js — merges the deck-library override batches. One file per batch so batches never conflict.
import m1 from "./m1.js";
import m2 from "./m2.js";
import m3 from "./m3.js";
import m4 from "./m4.js";
import b01 from "./b01.js";
import b02 from "./b02.js";
import b03 from "./b03.js";
import b04 from "./b04.js";
import b05 from "./b05.js";
import b06 from "./b06.js";
import b07 from "./b07.js";
import b08 from "./b08.js";
import b09 from "./b09.js";
import b10 from "./b10.js";
import b11 from "./b11.js";
import b12 from "./b12.js";
import b13 from "./b13.js";
import b14 from "./b14.js";
import b15 from "./b15.js";
import b16 from "./b16.js";
import b17 from "./b17.js";
import b18 from "./b18.js";

export default { ...m1, ...m2, ...m3, ...m4, ...b01, ...b02, ...b03, ...b04, ...b05, ...b06, ...b07, ...b08, ...b09, ...b10, ...b11, ...b12, ...b13, ...b14, ...b15, ...b16, ...b17, ...b18 };
export const BATCH_FILES = ["m1", "m2", "m3", "m4", "b01", "b02", "b03", "b04", "b05", "b06", "b07", "b08", "b09", "b10", "b11", "b12", "b13", "b14", "b15", "b16", "b17", "b18"];
