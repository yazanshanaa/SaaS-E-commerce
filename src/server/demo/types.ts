// src/server/demo/types.ts — the fixed contract for demo pack files (packs/*.json)
// B3 consumes this shape literally. Change it only from the main session.
//
// LANGUAGE RULE: code and identifiers are English; every value that reaches a human
// (names, descriptions, badges, alt text, testimonials) is Arabic — these packs are
// production-shaped content for Arabic-only storefronts.

export type PackKey = 'clothing' | 'industrial' | 'food';

export interface DemoPack {
  pack: PackKey;
  label: string;              // shown in the pack picker in Super Admin (Arabic)
  template: string;           // template key from the registry (A2)
  colors: { primary: string; secondary: string; background: string };
  announcementBar?: { text: string; link?: string };  // site-level top announcement bar
  tenant: {
    name: string;
    slugPrefix: string;       // final slug = `${slugPrefix}-${shortId}`
    tagline: string;
    about: string;
    whatsapp: string;         // placeholder — replace before sending a demo, or leave (demos are watermarked)
    phone: string;            // placeholder
    address: string;
    hours: string;
  };
  categories: { key: string; name: string }[];
  sections: { type: string; sort: number; config: Record<string, unknown> }[];
  products: DemoProduct[];
  testimonials: { name: string; text: string }[];
}

export interface DemoProduct {
  sku: string;                // also the real-photo filename key: seed-assets/{pack}/{sku}.*
  name: string;
  description: string;
  price: number;
  currency: 'ILS';
  category: string;           // must match categories[].key
  available: boolean;
  badge?: string;             // "جديد" | "الأكثر مبيعاً" | "عرض"
  imageAlt: string;           // required (A3 policy) — Arabic
}
