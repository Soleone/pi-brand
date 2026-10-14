// The demo's sample names and how each one fares in a check, shared by the scripted model and the research stand-ins.
// Every search result is made up and points at example.com, example.org or example.net.

// Two ranked lists of 24 names with a flavor note; the second answers "More" once the first is used up.
export const NAME_LISTS: [string, string][][] = [
  [
    ["Sprig", "small, fresh, easy to say"],
    ["Sipling", "sip and sapling, playful"],
    ["Dewdrop", "gentle morning water"],
    ["Thirsty", "the plant's point of view"],
    ["Leafwise", "knows what each leaf needs"],
    ["Rootbeat", "a steady rhythm at the roots"],
    ["Drizzle", "light, regular watering"],
    ["Greenhour", "the daily care moment"],
    ["Mossy", "soft, cozy, houseplant mood"],
    ["Tendril", "reaching and growing"],
    ["Sprout", "new growth, instantly clear"],
    ["Puddle", "playful, a little messy"],
    ["Canopy", "a whole room of plants"],
    ["Fernly", "friendly, a little old-fashioned"],
    ["Petal", "light and bright"],
    ["Bloomly", "a promise of flowers"],
    ["Seedling", "care from the very start"],
    ["Lush", "what a watered plant looks like"],
    ["Verdant", "rich green, a bit formal"],
    ["Trickle", "a little water, often"],
    ["Dewpoint", "the right moment to water"],
    ["Pothos", "the classic easy houseplant"],
    ["Rainday", "a reminder that rain is due"],
    ["Wellroot", "healthy from the bottom up"],
  ],
  [
    ["Sipwell", "drink up, grow well"],
    ["Greenly", "an everyday green habit"],
    ["Splash", "quick and cheerful"],
    ["Brook", "a calm, steady flow"],
    ["Mistral", "a light mist of care"],
    ["Thrive", "the goal, in one word"],
    ["Leaflet", "a small note for each plant"],
    ["Rainbell", "a bell that says it's time"],
    ["Hydra", "water, with a wink"],
    ["Plantpal", "a buddy for your plants"],
    ["Wetfoot", "roots that stay happy"],
    ["Glade", "a quiet green corner"],
  ],
];

type Profile = { kind: "clear" | "unrelated" | "collision"; unrelated: number; reason: string; results: { title: string; url: string; snippet: string }[] };

// Names that collide with a (made-up) plant care app, and names with a few unrelated uses. The rest are clear.
const collisions = new Set(["sprout", "bloomly", "thirsty", "plantpal", "thrive"]);
const crowded: Record<string, number> = { lush: 3, canopy: 3, puddle: 2, splash: 2, petal: 2, sprig: 1, drizzle: 1, mossy: 1, brook: 1, glade: 1 };

export function profileOf(name: string): Profile {
  const key = name.toLowerCase();
  if (collisions.has(key)) {
    return {
      kind: "collision", unrelated: 0,
      reason: `A plant care app called ${name} already sends watering reminders`,
      results: [
        { title: `${name}: plant care and watering reminders`, url: `https://${key}.example.com/`, snippet: `${name} reminds you when to water each houseplant, with care tips for over 3,000 species.` },
        { title: `${name} in the app store`, url: `https://apps.example.org/${key}-plant-care`, snippet: `${name}: Plant Care. Watering schedules and reminders for your plants.` },
      ],
    };
  }
  const unrelated = crowded[key] ?? 0;
  const uses = ["a coffee bar", "a knitting pattern shop", "a design studio", "a children's book"].slice(0, unrelated);
  return {
    kind: unrelated > 0 ? "unrelated" : "clear", unrelated,
    reason: unrelated > 0 ? `Used by ${uses.join(", ")}; nothing in plant care` : "No product using this name turned up",
    results: [
      { title: `${name}: definition and meaning`, url: `https://dictionary.example.net/${key}`, snippet: `The word ${key} in a dictionary; no product or app.` },
      ...uses.map((use, index) => ({ title: `${name}, ${use}`, url: `https://${key}-${index + 1}.example.org/`, snippet: `${name} is ${use}, unrelated to plants or reminders.` })),
    ],
  };
}
