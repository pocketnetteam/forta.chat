export interface EmojiCategory {
  name: string;
  icon: string;
  emojis: string[];
}

/** Keyword index for emoji search — maps emoji to searchable terms */
const EMOJI_KEYWORDS: Record<string, string> = {
  "\u{1F600}": "grinning grin happy smile",
  "\u{1F603}": "smiley happy smile open",
  "\u{1F604}": "smile happy eyes grin",
  "\u{1F601}": "grin beaming smile teeth",
  "\u{1F606}": "laughing lol haha squint",
  "\u{1F605}": "sweat smile nervous haha",
  "\u{1F602}": "joy tears laugh crying lol",
  "\u{1F923}": "rofl rolling floor laugh",
  "\u{1F60A}": "blush smile happy warm",
  "\u{1F607}": "innocent angel halo",
  "\u{1F642}": "slight smile",
  "\u{1F643}": "upside down silly",
  "\u{1F609}": "wink ;)",
  "\u{1F60C}": "relieved content calm",
  "\u{1F60D}": "heart eyes love",
  "\u{1F970}": "smiling hearts love adore",
  "\u{1F618}": "kiss blow heart",
  "\u{1F617}": "kissing",
  "\u{1F619}": "kissing smile",
  "\u{1F61A}": "kissing closed",
  "\u{1F60B}": "yum delicious tongue",
  "\u{1F61B}": "tongue stuck out",
  "\u{1F61C}": "wink tongue playful",
  "\u{1F92A}": "zany crazy wild",
  "\u{1F61D}": "tongue squint",
  "\u{1F911}": "money mouth rich dollar",
  "\u{1F917}": "hugging hug",
  "\u{1F92D}": "hand mouth oops",
  "\u{1F92B}": "shush quiet secret",
  "\u{1F914}": "thinking hmm wonder",
  "\u{1F910}": "zipper mouth silent",
  "\u{1F928}": "raised eyebrow skeptical",
  "\u{1F610}": "neutral meh",
  "\u{1F611}": "expressionless blank",
  "\u{1F636}": "no mouth silent",
  "\u{1F60F}": "smirk sly",
  "\u{1F612}": "unamused bored",
  "\u{1F644}": "eye roll whatever",
  "\u{1F62C}": "grimace awkward",
  "\u{1F925}": "lying liar pinocchio",
  "\u{1F60E}": "sunglasses cool",
  "\u{1F913}": "nerd glasses smart",
  "\u{1F9D0}": "monocle curious",
  "\u{1F615}": "confused",
  "\u{1F61F}": "worried nervous",
  "\u{1F641}": "slightly frowning sad",
  "\u2639\uFE0F": "frowning sad unhappy",
  "\u{1F62E}": "open mouth wow",
  "\u{1F62F}": "hushed surprised",
  "\u{1F632}": "astonished shocked",
  "\u{1F633}": "flushed embarrassed blush",
  "\u{1F97A}": "pleading puppy eyes",
  "\u{1F626}": "frowning open mouth",
  "\u{1F627}": "anguished",
  "\u{1F628}": "fearful scared",
  "\u{1F630}": "cold sweat anxious",
  "\u{1F625}": "disappointed relieved",
  "\u{1F622}": "cry crying sad tear",
  "\u{1F62D}": "sob crying loud",
  "\u{1F631}": "scream horror",
  "\u{1F616}": "confounded",
  "\u{1F623}": "persevere struggle",
  "\u{1F61E}": "disappointed sad",
  "\u{1F613}": "sweat worried",
  "\u{1F629}": "weary tired",
  "\u{1F62A}": "sleepy tired",
  "\u{1F924}": "drooling drool",
  "\u{1F634}": "sleeping zzz sleep",
  "\u{1F637}": "mask sick",
  "\u{1F912}": "thermometer fever sick",
  "\u{1F915}": "bandage hurt injured",
  "\u{1F922}": "nauseated sick green",
  "\u{1F92E}": "vomiting puke sick",
  "\u{1F927}": "sneezing achoo",
  "\u{1F975}": "hot warm fire",
  "\u{1F976}": "cold freezing ice",
  "\u{1F974}": "woozy drunk dizzy",
  "\u{1F635}": "dizzy dazed",
  "\u{1F92F}": "exploding head mind blown",
  "\u{1F920}": "cowboy hat",
  // Gestures
  "\u{1F44D}": "thumbs up like yes good ok +1",
  "\u{1F44E}": "thumbs down dislike no bad -1",
  "\u{1F44A}": "fist bump punch",
  "\u270A": "raised fist power",
  "\u{1F91B}": "left fist",
  "\u{1F91C}": "right fist",
  "\u{1F44F}": "clap applause bravo",
  "\u{1F64C}": "raised hands praise hooray",
  "\u{1F450}": "open hands",
  "\u{1F932}": "palms up",
  "\u{1F91D}": "handshake deal",
  "\u{1F64F}": "pray please hope folded hands thank",
  "\u270D\uFE0F": "writing hand",
  "\u{1F485}": "nail polish",
  "\u{1F933}": "selfie",
  "\u{1F4AA}": "muscle strong flex",
  "\u{1F448}": "point left",
  "\u{1F449}": "point right",
  "\u261D\uFE0F": "point up index",
  "\u{1F446}": "point up",
  "\u{1F595}": "middle finger",
  "\u{1F447}": "point down",
  "\u270C\uFE0F": "victory peace v",
  "\u{1F91E}": "crossed fingers luck",
  "\u{1F596}": "vulcan spock",
  "\u{1F918}": "rock on metal horns",
  "\u{1F919}": "call me hang loose",
  "\u{1F590}\uFE0F": "hand splayed",
  "\u270B": "raised hand stop",
  "\u{1F44B}": "wave hello bye",
  "\u{1F44C}": "ok perfect",
  "\u{1F90F}": "pinching small",
  // Hearts
  "\u2764\uFE0F": "red heart love",
  "\u{1F9E1}": "orange heart",
  "\u{1F49B}": "yellow heart",
  "\u{1F49A}": "green heart",
  "\u{1F499}": "blue heart",
  "\u{1F49C}": "purple heart",
  "\u{1F5A4}": "black heart",
  "\u{1F90D}": "white heart",
  "\u{1F90E}": "brown heart",
  "\u{1F498}": "cupid arrow heart",
  "\u{1F49D}": "heart ribbon gift",
  "\u{1F496}": "sparkling heart",
  "\u{1F497}": "growing heart",
  "\u{1F493}": "beating heart pulse",
  "\u{1F49E}": "revolving hearts",
  "\u{1F495}": "two hearts",
  "\u{1F48C}": "love letter",
  "\u{1F48B}": "kiss lips",
  "\u{1F48D}": "ring wedding",
  "\u{1F48E}": "gem diamond",
  "\u{1F494}": "broken heart",
  "\u2763\uFE0F": "heart exclamation",
  "\u{1F49F}": "heart decoration",
  "\u2665\uFE0F": "heart suit",
  // Symbols
  "\u2705": "check mark done yes",
  "\u274C": "cross mark no x",
  "\u2757": "exclamation warning",
  "\u2753": "question",
  "\u{1F4AF}": "hundred perfect 100",
  "\u{1F525}": "fire hot flame lit",
  "\u2728": "sparkles magic",
  "\u{1F31F}": "glowing star",
  "\u{1F4A5}": "boom explosion collision",
  "\u{1F4A2}": "anger symbol",
  "\u{1F4A4}": "zzz sleep",
  "\u{1F4A8}": "dash wind fast",
  "\u{1F4AB}": "dizzy stars",
  "\u{1F440}": "eyes look see",
  "\u{1F4AC}": "speech bubble chat",
  "\u{1F4AD}": "thought bubble think",
  "\u{1F5E8}\uFE0F": "left speech bubble",
  "\u{1F4E2}": "loudspeaker announce",
  "\u{1F514}": "bell notification",
  "\u{1F515}": "bell off mute",
};

/** Search emojis by keyword — matches against category name + keyword index */
export function searchEmojis(query: string): string[] {
  if (!query) return [];
  const q = query.toLowerCase().trim();
  const results: string[] = [];
  const seen = new Set<string>();

  // 1. Exact keyword matches first
  for (const cat of EMOJI_CATEGORIES) {
    for (const emoji of cat.emojis) {
      const kw = EMOJI_KEYWORDS[emoji];
      if (kw && kw.includes(q) && !seen.has(emoji)) {
        results.push(emoji);
        seen.add(emoji);
      }
    }
  }

  // 2. Category name matches
  for (const cat of EMOJI_CATEGORIES) {
    if (cat.name.toLowerCase().includes(q)) {
      for (const emoji of cat.emojis) {
        if (!seen.has(emoji)) {
          results.push(emoji);
          seen.add(emoji);
        }
      }
    }
  }

  return results;
}

export const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    name: "Smileys",
    icon: "\u{1F600}",
    emojis: [
      "\u{1F600}", "\u{1F603}", "\u{1F604}", "\u{1F601}", "\u{1F606}", "\u{1F605}", "\u{1F602}", "\u{1F923}",
      "\u{1F60A}", "\u{1F607}", "\u{1F642}", "\u{1F643}", "\u{1F609}", "\u{1F60C}", "\u{1F60D}", "\u{1F970}",
      "\u{1F618}", "\u{1F617}", "\u{1F619}", "\u{1F61A}", "\u{1F60B}", "\u{1F61B}", "\u{1F61C}", "\u{1F92A}",
      "\u{1F61D}", "\u{1F911}", "\u{1F917}", "\u{1F92D}", "\u{1F92B}", "\u{1F914}", "\u{1F910}", "\u{1F928}",
      "\u{1F610}", "\u{1F611}", "\u{1F636}", "\u{1F60F}", "\u{1F612}", "\u{1F644}", "\u{1F62C}", "\u{1F925}",
      "\u{1F60E}", "\u{1F913}", "\u{1F9D0}", "\u{1F615}", "\u{1F61F}", "\u{1F641}", "\u2639\uFE0F", "\u{1F62E}",
      "\u{1F62F}", "\u{1F632}", "\u{1F633}", "\u{1F97A}", "\u{1F626}", "\u{1F627}", "\u{1F628}", "\u{1F630}",
      "\u{1F625}", "\u{1F622}", "\u{1F62D}", "\u{1F631}", "\u{1F616}", "\u{1F623}", "\u{1F61E}", "\u{1F613}",
      "\u{1F629}", "\u{1F62A}", "\u{1F924}", "\u{1F634}", "\u{1F637}", "\u{1F912}", "\u{1F915}", "\u{1F922}",
      "\u{1F92E}", "\u{1F927}", "\u{1F975}", "\u{1F976}", "\u{1F974}", "\u{1F635}", "\u{1F92F}", "\u{1F920}",
    ],
  },
  {
    name: "Gestures",
    icon: "\u{1F44D}",
    emojis: [
      "\u{1F44D}", "\u{1F44E}", "\u{1F44A}", "\u270A", "\u{1F91B}", "\u{1F91C}", "\u{1F44F}", "\u{1F64C}",
      "\u{1F450}", "\u{1F932}", "\u{1F91D}", "\u{1F64F}", "\u270D\uFE0F", "\u{1F485}", "\u{1F933}", "\u{1F4AA}",
      "\u{1F448}", "\u{1F449}", "\u261D\uFE0F", "\u{1F446}", "\u{1F595}", "\u{1F447}", "\u270C\uFE0F", "\u{1F91E}",
      "\u{1F596}", "\u{1F918}", "\u{1F919}", "\u{1F590}\uFE0F", "\u270B", "\u{1F44B}", "\u{1F44C}", "\u{1F90F}",
    ],
  },
  {
    name: "Hearts",
    icon: "\u2764\uFE0F",
    emojis: [
      "\u2764\uFE0F", "\u{1F9E1}", "\u{1F49B}", "\u{1F49A}", "\u{1F499}", "\u{1F49C}", "\u{1F5A4}", "\u{1F90D}",
      "\u{1F90E}", "\u{1F498}", "\u{1F49D}", "\u{1F496}", "\u{1F497}", "\u{1F493}", "\u{1F49E}", "\u{1F495}",
      "\u{1F48C}", "\u{1F48B}", "\u{1F48D}", "\u{1F48E}", "\u{1F494}", "\u2763\uFE0F", "\u{1F49F}", "\u2665\uFE0F",
    ],
  },
  {
    name: "Animals",
    icon: "\u{1F431}",
    emojis: [
      "\u{1F436}", "\u{1F431}", "\u{1F42D}", "\u{1F439}", "\u{1F430}", "\u{1F98A}", "\u{1F43B}", "\u{1F43C}",
      "\u{1F428}", "\u{1F42F}", "\u{1F981}", "\u{1F42E}", "\u{1F437}", "\u{1F438}", "\u{1F435}", "\u{1F648}",
      "\u{1F649}", "\u{1F64A}", "\u{1F412}", "\u{1F414}", "\u{1F427}", "\u{1F426}", "\u{1F985}", "\u{1F989}",
      "\u{1F987}", "\u{1F43A}", "\u{1F417}", "\u{1F434}", "\u{1F984}", "\u{1F41D}", "\u{1F41B}", "\u{1F98B}",
      "\u{1F40C}", "\u{1F41A}", "\u{1F41E}", "\u{1F41C}", "\u{1F577}\uFE0F", "\u{1F422}", "\u{1F40D}", "\u{1F98E}",
      "\u{1F982}", "\u{1F980}", "\u{1F990}", "\u{1F991}", "\u{1F419}", "\u{1F420}", "\u{1F41F}", "\u{1F421}",
    ],
  },
  {
    name: "Food",
    icon: "\u{1F354}",
    emojis: [
      "\u{1F34E}", "\u{1F34F}", "\u{1F350}", "\u{1F34A}", "\u{1F34B}", "\u{1F34C}", "\u{1F349}", "\u{1F347}",
      "\u{1F353}", "\u{1F348}", "\u{1F352}", "\u{1F351}", "\u{1F34D}", "\u{1F965}", "\u{1F95D}", "\u{1F345}",
      "\u{1F346}", "\u{1F951}", "\u{1F955}", "\u{1F33D}", "\u{1F336}\uFE0F", "\u{1F952}", "\u{1F966}", "\u{1F344}",
      "\u{1F35E}", "\u{1F950}", "\u{1F956}", "\u{1F354}", "\u{1F35F}", "\u{1F355}", "\u{1F32D}", "\u{1F32E}",
      "\u{1F32F}", "\u{1F959}", "\u{1F9C6}", "\u{1F95A}", "\u{1F373}", "\u{1F958}", "\u{1F372}", "\u{1F963}",
      "\u{1F957}", "\u{1F375}", "\u2615", "\u{1F37A}", "\u{1F37B}", "\u{1F377}", "\u{1F378}", "\u{1F379}",
    ],
  },
  {
    name: "Objects",
    icon: "\u{1F3B5}",
    emojis: [
      "\u26BD", "\u{1F3C0}", "\u{1F3C8}", "\u26BE", "\u{1F94E}", "\u{1F3BE}", "\u{1F3B1}", "\u{1F3D3}",
      "\u{1F3B5}", "\u{1F3B6}", "\u{1F3A4}", "\u{1F3B9}", "\u{1F3B8}", "\u{1F3BB}", "\u{1F941}", "\u{1F3AC}",
      "\u{1F4F7}", "\u{1F4F8}", "\u{1F4F9}", "\u{1F3AE}", "\u{1F579}\uFE0F", "\u{1F4BB}", "\u{1F4F1}", "\u260E\uFE0F",
      "\u{1F4A1}", "\u{1F526}", "\u{1F4DA}", "\u{1F4D6}", "\u{1F4DD}", "\u270F\uFE0F", "\u{1F4CE}", "\u{1F4CB}",
      "\u{1F511}", "\u{1F512}", "\u{1F513}", "\u{1F528}", "\u{1F4B0}", "\u{1F4B3}", "\u{1F381}", "\u{1F389}",
      "\u{1F388}", "\u{1F380}", "\u{1F3C6}", "\u{1F3C5}", "\u{1F947}", "\u{1F948}", "\u{1F949}", "\u2B50",
    ],
  },
  {
    name: "Symbols",
    icon: "\u2705",
    emojis: [
      "\u2705", "\u274C", "\u2757", "\u2753", "\u{1F4AF}", "\u{1F525}", "\u2728", "\u{1F31F}",
      "\u{1F4A5}", "\u{1F4A2}", "\u{1F4A4}", "\u{1F4A8}", "\u{1F4AB}", "\u{1F44B}", "\u{1F440}", "\u{1F4AC}",
      "\u{1F4AD}", "\u{1F5E8}\uFE0F", "\u{1F4E2}", "\u{1F514}", "\u{1F515}", "\u{1F3F3}\uFE0F", "\u{1F3F4}", "\u{1F6A9}",
    ],
  },
];

export const ALL_EMOJIS = EMOJI_CATEGORIES.flatMap(c => c.emojis);
