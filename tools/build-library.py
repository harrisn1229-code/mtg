#!/usr/bin/env python3
"""Build data/library.json for the cards app from official Commander precon lists.

Inputs (untrusted data, read only):
  --precons  taw/magic-preconstructed-decks checkout (data/cmd/<set>/<Deck>.txt)
  --cards    taw/magic-search-engine index/cards.jsonl
  --sfids    taw/magic-search-engine index/scryfall_ids.txt (set, number, scryfall id, name)
  --seed     the app's data/seed.json (to reuse oracle ids for cards Nate already has)
"""
import argparse, json, re, sys, unicodedata
from pathlib import Path

PICKS = [
    # set, deck file name, short theme
    ("ltc", "The Hosts of Mordor", "Sauron's Orc armies, amass and the Ring"),
    ("ltc", "Riders of Rohan", "Human go-wide attackers"),
    ("ltc", "Food and Fellowship", "Hobbits, Food tokens and lifegain"),
    ("ltc", "Elven Council", "Elves, voting and flicker value"),
    ("pip", "Scrappy Survivors", "Equipment and Auras on scrappy creatures"),
    ("pip", "Science!", "Energy counters and artifacts"),
    ("pip", "Mutant Menace", "Rad counters and mill"),
    ("pip", "Hail, Caesar", "Go-wide Soldier tokens and politics"),
    ("fic", "Limit Break (FINAL FANTASY VII)", "Equipment-heavy Voltron"),
    ("fic", "Counter Blitz (FINAL FANTASY X)", "Saga and counters tricks"),
    ("fic", "Revival Trance (FINAL FANTASY VI)", "Graveyard recursion"),
    ("fic", "Scions & Spellcraft (FINAL FANTASY XIV)", "Spellslinger"),
    ("tdc", "Abzan Armor", "+1/+1 counters and toughness matters"),
    ("tdc", "Jeskai Striker", "Spells and flurry attacks"),
    ("tdc", "Mardu Surge", "Aggressive attack triggers"),
    ("tdc", "Sultai Arisen", "Self-mill and graveyard value"),
    ("tdc", "Temur Roar", "Big creatures and ferocious"),
    ("blc", "Squirreled Away", "Squirrels, Food and forage"),
    ("blc", "Peace Offering", "Group hug and Rabbits"),
    ("blc", "Family Matters", "Multicolored spells and tokens"),
    ("blc", "Animated Army", "Auras, Equipment and offspring"),
    ("m3c", "Tricky Terrain", "Lands matter and landfall"),
    ("m3c", "Graveyard Overdrive", "Reanimation"),
    ("m3c", "Eldrazi Incursion", "Colorless Eldrazi ramp"),
    ("m3c", "Creative Energy", "Energy and artifacts"),
    ("otc", "Quick Draw", "Spells and copy effects"),
    ("otc", "Most Wanted", "Outlaws and Treasure"),
    ("otc", "Grand Larceny", "Steal opponents' cards"),
    ("otc", "Desert Bloom", "Deserts and landfall"),
    ("mkc", "Revenant Recon", "Artifacts and surveil"),
    ("mkc", "Deep Clue Sea", "Clues and card draw"),
    ("mkc", "Deadly Disguise", "Face-down creatures"),
    ("mkc", "Blame Game", "Goad and forced attacks"),
    ("lcc", "Veloci-Ramp-Tor", "Dinosaurs and ramp"),
    ("lcc", "Explorers of the Deep", "Merfolk and explore"),
    ("lcc", "Blood Rites", "Vampires and lifedrain"),
    ("lcc", "Ahoy Mateys", "Pirates and Treasure"),
    ("cmm", "Sliver Swarm", "Five-color Slivers"),
    ("cmm", "Planeswalker Party", "Superfriends"),
    ("cmm", "Enduring Enchantments", "Enchantress"),
    ("cmm", "Eldrazi Unbound", "Big Eldrazi and Spawn"),
    ("40k", "Tyranid Swarm", "Ravenous X creatures and counters"),
    ("40k", "The Ruinous Powers", "Chaos, cascade and random"),
    ("40k", "Necron Dynasties", "Artifact creatures and reanimation"),
    ("40k", "Forces of the Imperium", "Vehicles and Soldiers"),
    ("fdc", "Wretched Ranks", "Zombie tokens and sacrifice"),
    ("fdc", "Tramplesaurus Rex", "Huge green stompy"),
    ("fdc", "Reign of Dragons", "Dragons"),
    ("eoc", "World Shaper", "Lands and landfall"),
    ("eoc", "Counter Intelligence", "Artifacts and counters"),
]

RARITY = {0: "common", 1: "common", 2: "uncommon", 3: "rare", 4: "mythic", 5: "special"}
TYPE_ORDER = ["Creature", "Planeswalker", "Battle", "Instant", "Sorcery", "Artifact", "Enchantment", "Land"]
TYPE_SECTION = {"Creature": "Creatures", "Planeswalker": "Planeswalkers", "Battle": "Battles", "Instant": "Instants",
                "Sorcery": "Sorceries", "Artifact": "Artifacts", "Enchantment": "Enchantments", "Land": "Lands"}
LINE = re.compile(r"^(?:(COMMANDER):\s*)?(\d+)\s+(.+?)((?:\s*\[[^\]]+\])*)\s*$")


def fold(s):
    return unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", fold(s)).strip("-")


def cost(m):
    return re.sub(r"\{([^}]*)\}", lambda x: "{" + x.group(1).upper() + "}", m or "")


def colors(s):
    return sorted(c for c in "WUBRG" if c.lower() in (s or ""))


def type_line(c):
    left = " ".join((c.get("tp") or []) + (c.get("t") or []))
    sub = " ".join(c.get("tb") or [])
    return left + (" — " + sub if sub else "")


def pt(c):
    if c.get("p") is None or c.get("to") is None:
        return None
    return f"{c['p']}/{c['to']}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--precons", required=True)
    ap.add_argument("--cards", required=True)
    ap.add_argument("--sfids", required=True)
    ap.add_argument("--seed", required=True)
    ap.add_argument("--sets", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    db = {}
    for line in open(a.cards, encoding="utf-8"):
        n, c = json.loads(line)
        db[n] = c
    sfid = {}
    for line in open(a.sfids, encoding="utf-8"):
        p = line.rstrip("\n").split("\t")
        if len(p) >= 4:
            sfid[(p[0], p[1])] = p[2]
    set_names = dict(re.findall(r'"([^"]+)" => "([^"]+)"', open(a.sets, encoding="utf-8").read()))
    seed = json.load(open(a.seed, encoding="utf-8"))
    oracle_by_name = {fold(c["name"]): c["oracle_id"] for c in seed["cards"].values() if c.get("oracle_id")}
    by_fold = {fold(n): n for n in db}

    def printings(name, set_code):
        return [p for s, p in db[name]["*"] if s == set_code]

    def pick_printing(name, set_code, num):
        c = db[name]
        prs = c["*"]
        if set_code and num:
            for s, p in prs:
                if s == set_code and (p["n"] == num or p["n"].rstrip("ab") == num):
                    return s, p
        if set_code:
            cand = printings(name, set_code)
            if cand:
                cand.sort(key=lambda p: (bool(p.get("fe")), len(p["n"]), p["n"]))
                return set_code, cand[0]
        # fall back to the newest normal paper printing
        normal = [(s, p) for s, p in prs if not p.get("!") or p.get("!") in ("a",)]
        pool = normal or prs
        return pool[-1]

    cards_out = {}

    def card_record(name, set_code, p, released):
        c = db[name]
        cn = re.sub(r"[ab]$", "", p["n"]) if c.get("ns") else p["n"]
        key = f"{set_code}:{cn}"
        if key in cards_out:
            return key
        sid = sfid.get((set_code, p["n"])) or sfid.get((set_code, cn))
        img = f"https://cards.scryfall.io/normal/front/{sid[0]}/{sid[1]}/{sid}.jpg" if sid else None
        full = name
        faces = None
        if c.get("ns") and len(c["ns"]) > 1:
            full = " // ".join(c["ns"])
            fs = [db[x] for x in c["ns"] if x in db]
            two_img = c.get("l") in ("transform", "modal_dfc", "double_faced", "reversible_card")
            faces = []
            for i, (fn, f) in enumerate(zip(c["ns"], fs)):
                o = {"name": fn, "mana_cost": cost(f.get("m")), "type_line": type_line(f), "oracle_text": f.get("o") or ""}
                if pt(f):
                    o["pt"] = pt(f)
                if two_img and sid:
                    o["img"] = f"https://cards.scryfall.io/normal/{'front' if i == 0 else 'back'}/{sid[0]}/{sid[1]}/{sid}.jpg"
                faces.append(o)
            front = fs[0]
        else:
            front = c
        two_faced = faces is not None and c.get("l") in ("transform", "modal_dfc", "double_faced", "reversible_card")
        rec = {
            "id": sid or ("lib-" + slug(full)),
            "oracle_id": oracle_by_name.get(fold(full)) or ("name:" + fold(full)),
            "name": full,
            "set": set_code,
            "set_name": set_names.get(set_code, set_code.upper()),
            "cn": cn,
            "rarity": RARITY.get(p.get("r"), "common"),
            "released": released,
            "mana_cost": cost(front.get("m")) if (faces is None or two_faced) else " // ".join(cost(db[x].get("m")) for x in c["ns"]),
            "cmc": front.get("v", 0) if isinstance(front.get("v", 0), (int, float)) else 0,
            "type_line": " // ".join(f["type_line"] for f in faces) if faces else type_line(c),
            "oracle_text": "" if faces else (c.get("o") or ""),
            "colors": colors(front.get("c")),
            "color_identity": colors(c.get("ci")),
            "legal_commander": "legal",
            "img": img,
            "finishes": ["nonfoil"],
            "prices": {"usd": None, "usd_foil": None, "usd_etched": None},
        }
        if faces is None and pt(c):
            rec["pt"] = pt(c)
        elif faces and pt(front):
            rec["pt"] = pt(front)
        if front.get("ly") is not None:
            rec["loyalty"] = str(front["ly"])
        if c.get("gc"):
            rec["game_changer"] = True
        if faces:
            rec["faces"] = faces
        cards_out[key] = rec
        return key

    decks = []
    problems = []
    for set_code, deck_name, theme in PICKS:
        path = Path(a.precons) / "data" / "cmd" / set_code / (deck_name + ".txt")
        text = path.read_text(encoding="utf-8")
        date = (re.search(r"^// DATE: (\S+)", text, re.M) or [None, None])[1] or ""
        src = (re.search(r"^// SOURCE: (\S+)", text, re.M) or [None, None])[1] or ""
        section = "main"
        entries = []
        commander = None
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("//"):
                continue
            low = line.lower()
            if low in ("sideboard", "tokens", "display commander", "planar deck", "scheme deck"):
                section = "skip"
                continue
            if low in ("main deck", "commander"):
                section = "commander" if low == "commander" else "main"
                continue
            if section == "skip":
                continue
            m = LINE.match(line)
            if not m:
                problems.append(f"{deck_name}: can't read '{line}'")
                continue
            is_cmd = bool(m.group(1)) or section == "commander"
            qty = int(m.group(2))
            name = m.group(3).strip()
            tags = re.findall(r"\[([^\]]+)\]", m.group(4) or "")
            if "token" in [t.lower() for t in tags]:
                continue
            ann = [t for t in tags if t.lower() not in ("foil", "etched")]
            cset, cnum = set_code, None
            if ann:
                bits = ann[0].split(":")
                cset = bits[0].lower()
                cnum = bits[1] if len(bits) > 1 and bits[1] != "*" else None
            real = name if name in db else by_fold.get(fold(name)) or by_fold.get(fold(name.split(" // ")[0]))
            if not real:
                problems.append(f"{deck_name}: unknown card '{name}'")
                continue
            if db[real].get("s") and db[real].get("ns"):
                real = db[real]["ns"][0]
            s, p = pick_printing(real, cset, cnum)
            key = card_record(real, s, p, date)
            rec = cards_out[key]
            sec = "Commander" if is_cmd else TYPE_SECTION.get(next((t for t in TYPE_ORDER if re.search(r"\b" + t + r"\b", rec["type_line"].split(" // ")[0])), "Land"), "Other")
            if is_cmd and not commander:
                commander = rec["name"]
            ex = next((e for e in entries if e["set"] == rec["set"] and e["cn"] == rec["cn"] and e["section"] == sec), None)
            if ex:
                ex["qty"] += qty
            else:
                entries.append({"set": rec["set"], "cn": rec["cn"], "finish": "nonfoil", "qty": qty, "section": sec})
        total = sum(e["qty"] for e in entries)
        if total != 100:
            problems.append(f"{deck_name}: {total} cards")
        order = ["Commander"] + [TYPE_SECTION[t] for t in TYPE_ORDER]
        entries.sort(key=lambda e: (order.index(e["section"]) if e["section"] in order else 99,
                                    cards_out[f"{e['set']}:{e['cn']}"]["cmc"], cards_out[f"{e['set']}:{e['cn']}"]["name"]))
        ci = set()
        for e in entries:
            if e["section"] == "Commander":
                ci.update(cards_out[f"{e['set']}:{e['cn']}"]["color_identity"])
        decks.append({
            "id": "lib-" + slug(deck_name.split(" (")[0] + "-" + set_code),
            "name": deck_name.split(" (")[0],
            "format": "commander",
            "commander": commander,
            "archetype": theme,
            "bracket": 2,
            "created": date or None,
            "updated": date or None,
            "count": total,
            "status": "library",
            "product": set_names.get(set_code, set_code.upper()),
            "source": src,
            "entries": entries,
        })
    out = {"app": "mtg", "kind": "library", "version": "2026-11-22", "decks": decks, "cards": cards_out}
    Path(a.out).write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(decks)} decks, {len(cards_out)} card printings, {Path(a.out).stat().st_size/1e6:.2f} MB")
    for p in problems:
        print("PROBLEM:", p)


if __name__ == "__main__":
    main()
