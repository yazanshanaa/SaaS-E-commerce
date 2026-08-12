import 'dotenv/config';
import { hash as argon2Hash } from '@node-rs/argon2';
import {
  authDb,
  disconnectAll,
  superAdminDb,
  tenantDb,
  verifiedActor,
  withTenantTxn,
} from '../src/server/db';
import { exportDownloadUrl, resetEnvCache, storefrontHost } from '../src/env';
import * as billing from '../src/server/billing';
import { decideDomainAsk } from '../src/server/domains';
import { placeOrder, changeOrderStatus } from '../src/server/orders';
import { closeQueues } from '../src/server/queues';
import { closeRedis } from '../src/server/redis';
import { createDemoImageWriter, type DemoImageWriter } from '../src/server/demo/images';
import { createAccountFromAdmin } from '../src/server/admin/accounts';
import { setCapabilityOverride, setFeatureOverride } from '../src/server/admin/access';
import { applyChangeRequest, rejectChangeRequest } from '../src/server/admin/change-requests';
import { saveGatewayCredentials, setAccountGatewayEnabled } from '../src/server/admin/gateways';
import { seedDefaultSections } from '../src/server/admin/site-content';
import { submitChangeRequest } from '../src/app/dashboard/_lib/change-requests';
import { addDomain } from '../src/app/dashboard/_lib/domains';
import { saveCategory, saveProduct } from '../src/app/dashboard/_lib/products';
import { saveColors } from '../src/app/dashboard/_lib/appearance';
import { savePayments } from '../src/app/dashboard/_lib/settings';
import {
  saveAnnouncement,
  saveAnnouncementBar,
  saveDetails,
  saveMap,
  saveSocialLinks,
} from '../src/app/dashboard/_lib/site';
import type { StoredFeatureValue } from '../src/server/admin/access';
import type { AdminContext } from '../src/server/admin/context';
import type { MerchantContext } from '../src/app/dashboard/_lib/context';
import type { ActionState } from '../src/server/admin/validation';
import type { CapabilityKey, FeatureKey } from '../src/shared/features';
import type { DemoProduct, PackKey } from '../src/server/demo/types';

/**
 * The realistic scenario seed (Phase 7, TODO.md → "10 merchants across the three plans in
 * different states").
 *
 * WHY THIS IS A SEPARATE SCRIPT AND NOT PART OF `prisma/seed.ts`.
 * `prisma/seed.ts` is a fixture, not a demo of the product. `tests/integration/seed.test.ts` runs
 * it for real and pins its shape — the exact plan list, exactly one hidden plan, and a
 * `findFirstOrThrow` on `isDemo` with no `orderBy` — inside a 180-second hook budget; and
 * `tests/e2e/support/start-stack.ts` runs it again for every Playwright session, so anything
 * added there lengthens every e2e boot and changes the baseline data of 121 specs. Ten merchants
 * with catalogues, orders and suspensions belong on top of that fixture, never inside it. This
 * file is therefore invoked explicitly and by a human.
 *
 * EVERY LIFECYCLE FACT GOES THROUGH A SERVICE (invariant 5). Accounts are created by
 * `createAccountFromAdmin` — the same function A1's form calls — and suspension, retention and
 * payments by `src/server/billing`. Nothing here writes `Subscription.status`, `suspendedAt`,
 * `retentionUntil`, `currentPeriodEnd` or `Tenant.state`, and nothing here writes a `Payment` row.
 * Three rows have no service seam at all — a product's image link, a testimonial, and the
 * `pending -> verified` step on a custom domain. Each is written on a `withTenantTxn` and each
 * carries the reason at its call site.
 *
 * IT REFUSES TO RUN ON A DATABASE THAT IS NOT A SANDBOX. A scenario seed that lands on a live box
 * writes ten merchants and their owners into a real tenant list, and there is no undo short of a
 * restore: `createAccountFromAdmin` writes audit rows, provisions analytics and mints identities.
 * So it stops on `NODE_ENV=production`, and it stops on any database that already holds a tenant
 * this script did not create unless `--force` is passed by someone who has read this paragraph.
 *
 * IT DEGRADES. Redis, R2 and Umami are all optional: entitlement cache drops swallow their errors,
 * `dispatchJob` races a five-second timer and reports rather than throws, `provisionAccountAnalytics`
 * returns `false` when Umami is unconfigured, and product images are best effort — a storage backend
 * that will not take bytes costs the catalogue its photographs and nothing else. The developer
 * running this has the dev compose and nothing else, and that is enough.
 *
 * Console output is English on purpose: this is an operator script, not a product surface. Every
 * string that will ever reach a shop's visitor — trade names, taglines, categories, products,
 * testimonials, payment instructions — is Arabic, because it is the merchant's own copy.
 */

const bootstrapActor = verifiedActor('super_admin', null);
const db = superAdminDb(bootstrapActor);

// -----------------------------------------------------------------------------
// The shape of a scenario merchant
// -----------------------------------------------------------------------------

interface ScenarioCategory {
  /** ASCII, stable, and what a product links by — the same rule B3's packs follow. */
  key: string;
  name: string;
}

interface ScenarioProduct {
  /** ASCII. It becomes the product slug too: an Arabic name percent-encodes into an unreadable URL. */
  sku: string;
  name: string;
  description: string;
  /** As the merchant would type it into the form. `priceField` turns it into agorot. */
  priceShekels: string;
  categoryKey: string;
  available: boolean;
  badge?: string;
  /** Arabic, required — `ProductImage.alt` is NOT NULL by design (invariant 4). */
  imageAlt: string;
}

interface ScenarioOrder {
  sku: string;
  quantity: number;
  customerName: string;
  customerPhone: string;
  note?: string;
  /** Where this order comes to rest. `pending` is a customer who has not been called back yet. */
  outcome: 'pending' | 'paid' | 'fulfilled' | 'cancelled';
  method?: 'cash' | 'bank_transfer' | 'card' | 'other';
}

interface ScenarioChangeRequest {
  capabilityKey: CapabilityKey;
  /** Already in the JSON shape `src/server/admin/capability-payloads` expects. */
  payload: unknown;
  note: string;
  decision: 'open' | 'applied' | 'rejected';
  decisionNote?: string;
}

interface ScenarioOverrides {
  features?: Array<{ key: FeatureKey; value: StoredFeatureValue }>;
  capabilities?: Array<{
    key: CapabilityKey;
    patch: { visible?: boolean; editableBy?: 'admin' | 'merchant' };
  }>;
}

type ScenarioColors =
  | { mode: 'preset'; presetKey: string }
  | { mode: 'custom'; primary: string; secondary: string; background: string };

type ScenarioLifecycle =
  | { state: 'active' }
  | {
      state: 'suspended';
      /** Overrides `RETENTION_DAYS` for this one suspension. See `withRetentionDays`. */
      retentionDays?: number;
      /** Days added afterwards through `billing.extendRetention`, which counts the extension. */
      extendRetentionDays?: number;
    };

interface ScenarioMerchant {
  slug: string;
  name: string;
  tagline: string;
  about: string;
  address: string;
  phone: string;
  /** E.164, and always +970 — these are West Bank numbers. */
  whatsapp: string;
  email: string;
  hours: string;
  ownerName: string;
  ownerEmail: string;
  planKey: 'basic' | 'store' | 'pro';
  billingPeriod: 'monthly' | 'yearly';
  templateKey: string;
  /** Days from today for the first period end. Negative means the account has already lapsed. */
  periodEndInDays: number;
  /** Which palette the generated product placeholders are drawn in. */
  imagePack: PackKey;
  colors: ScenarioColors;
  map?: { lat: string; lng: string; query: string };
  announcementBar?: { text: string; link?: string };
  announcements?: Array<{ title: string; body: string }>;
  social?: Array<{ platform: string; url: string }>;
  categories: ScenarioCategory[];
  products: ScenarioProduct[];
  testimonials: Array<{ name: string; text: string }>;
  overrides?: ScenarioOverrides;
  domain?: { hostname: string; status: 'pending' | 'verified' | 'active' };
  /** Turns the manual gateway on and opens the merchant's own selling switch. Pro only. */
  selling?: { instructions: string };
  orders?: ScenarioOrder[];
  changeRequests?: ScenarioChangeRequest[];
  lifecycle: ScenarioLifecycle;
  /** A subscription payment recorded by hand, the way the platform owner actually books one. */
  subscriptionPayment?: { method: 'cash' | 'bank_transfer'; note: string };
}

/**
 * Barta'a is a market town: fabric, shoes, sweets, aluminium, phones. The ten below are invented
 * businesses drawn from what is actually on that street, with Qabha as the family name it usually
 * is there. No Lorem Ipsum, no transliterated English, no Latin placeholder — a template that has
 * never been read with a real Arabic sentence in it has not been tested (CLAUDE.md design rules).
 *
 * Custom domains use the RFC 2606 reserved `.example` TLD. A seed must never claim a hostname that
 * could belong to a stranger: `Domain.hostname` is globally unique and is what `proxy.ts` resolves
 * against, so a plausible-looking real name in a shared database is a name nobody else can add.
 */
const MERCHANTS: ScenarioMerchant[] = [
  {
    slug: 'zaytouna-market',
    name: 'سوبرماركت الزيتونة',
    tagline: 'خضار وفواكه وبقالة يومية في قلب برطعة',
    about:
      'محل عائلي فتح أبوابه سنة 1998 في شارع السوق، ولليوم على نفس المبدأ: بضاعة طازة كل يوم، وسعر واضح مكتوب على كل صنف. بتقدر تبعت طلبك على الواتساب وبنجهّزه وبنوصّله على البيت داخل برطعة.',
    address: 'شارع السوق، برطعة الشرقية',
    phone: '04-2451180',
    whatsapp: '+970598114420',
    email: 'zaytouna@zaytouna-market.example',
    hours: 'السبت – الخميس: 7:00 صباحاً – 9:00 مساءً · الجمعة: 7:00 صباحاً – 12:00 ظهراً',
    ownerName: 'محمود قبها',
    ownerEmail: 'mahmoud@zaytouna-market.example',
    planKey: 'basic',
    billingPeriod: 'monthly',
    templateKey: 'diwan',
    periodEndInDays: 45,
    imagePack: 'food',
    colors: { mode: 'preset', presetKey: 'zaytoun' },
    announcementBar: { text: 'توصيل مجاني داخل برطعة لكل طلب فوق 150 شيكل' },
    social: [{ platform: 'facebook', url: 'https://www.facebook.com/zaytouna.bartaa.example' }],
    categories: [
      { key: 'khudar', name: 'خضار وفواكه' },
      { key: 'baqala', name: 'بقالة وتموين' },
      { key: 'albaan', name: 'ألبان وأجبان' },
    ],
    products: [
      {
        sku: 'zm-01',
        name: 'زيت زيتون بلدي – تنكة 3 لتر',
        description: 'عصرة هالسنة من زيتون المنطقة، معصور على البارد وبينحفظ بتنكة معدنية مغلقة.',
        priceShekels: '135',
        categoryKey: 'baqala',
        available: true,
        badge: 'الأكثر مبيعاً',
        imageAlt: 'تنكة زيت زيتون بلدي سعة ثلاثة لتر',
      },
      {
        sku: 'zm-02',
        name: 'زعتر بلدي مطحون – 500 غرام',
        description: 'زعتر مجفف بالشمس ومطحون مع السمسم المحمّص والسمّاق، بدون إضافات.',
        priceShekels: '28',
        categoryKey: 'baqala',
        available: true,
        imageAlt: 'كيس زعتر بلدي مطحون بوزن نصف كيلو',
      },
      {
        sku: 'zm-03',
        name: 'لبنة بلدية – كيلو',
        description: 'لبنة مصفّاة من حليب طازج، بتوصل المحل كل صباح ولازم تنحفظ بالبراد.',
        priceShekels: '32',
        categoryKey: 'albaan',
        available: true,
        badge: 'جديد',
        imageAlt: 'وعاء لبنة بلدية بوزن كيلو',
      },
      {
        sku: 'zm-04',
        name: 'صندوق بندورة – 5 كيلو',
        description: 'بندورة أرضية من مزارع المنطقة، مقطوفة نفس اليوم ومصنّفة حجم واحد.',
        priceShekels: '22',
        categoryKey: 'khudar',
        available: true,
        imageAlt: 'صندوق بندورة طازة بوزن خمسة كيلو',
      },
    ],
    testimonials: [
      {
        name: 'أم أحمد قبها',
        text: 'ببعت الطلبية على الواتساب وبتوصلني خلال ساعة. زيت الزيتون عندهم ما بينعاد.',
      },
    ],
    overrides: {
      // A goodwill bump agreed on the phone: they outgrew the أساسي cap but did not need متجر.
      features: [{ key: 'products_limit', value: 60 }],
    },
    changeRequests: [
      {
        capabilityKey: 'map_location',
        payload: { mapLat: 32.4718, mapLng: 35.1041, mapQuery: 'شارع السوق، برطعة الشرقية' },
        note: 'الدبوس على الخريطة واقع بالشارع الخطأ، بدنا ياه قدام باب المحل.',
        decision: 'applied',
        decisionNote: 'تم تعديل الموقع.',
      },
    ],
    orders: [
      {
        sku: 'zm-01',
        quantity: 2,
        customerName: 'سامر قبها',
        customerPhone: '+970599241733',
        note: 'بفضّل التوصيل بعد العصر.',
        outcome: 'fulfilled',
        method: 'cash',
      },
      {
        sku: 'zm-04',
        quantity: 1,
        customerName: 'هدى عوض',
        customerPhone: '+970568330219',
        outcome: 'pending',
      },
    ],
    lifecycle: { state: 'active' },
    subscriptionPayment: { method: 'cash', note: 'اشتراك الشهر، مقبوض نقداً بالمحل.' },
  },
  {
    slug: 'halawiyat-abu-ratib',
    name: 'حلويات أبو راتب',
    tagline: 'كنافة نابلسية وبقلاوة على أصولها',
    about:
      'فرن حلويات اشتغل من سنة 1986 على إيد أبو راتب، وبعده أولاده. الكنافة بتنعمل على الطلب وبتطلع من الفرن ساخنة، والبقلاوة بتنقلى بالسمنة البلدية وبتتحشى جوز وفستق حلبي.',
    address: 'شارع المدارس، برطعة الشرقية',
    phone: '04-2453907',
    whatsapp: '+970597802164',
    email: 'orders@halawiyat-abu-ratib.example',
    hours: 'كل يوم: 9:00 صباحاً – 11:00 ليلاً',
    ownerName: 'راتب قبها',
    ownerEmail: 'ratib@halawiyat-abu-ratib.example',
    planKey: 'basic',
    billingPeriod: 'yearly',
    templateKey: 'diwan',
    periodEndInDays: 240,
    imagePack: 'food',
    colors: { mode: 'preset', presetKey: 'sahra' },
    categories: [
      { key: 'kunafa', name: 'كنافة ومحليات ساخنة' },
      { key: 'baqlawa', name: 'بقلاوة وحلو عربي' },
      { key: 'munasabat', name: 'طلبات المناسبات' },
    ],
    products: [
      {
        sku: 'ar-01',
        name: 'كنافة نابلسية – صينية وسط',
        description: 'جبنة نابلسية وشعيرات وقطر دافي. بتنعمل على الطلب وبتلزم نص ساعة.',
        priceShekels: '90',
        categoryKey: 'kunafa',
        available: true,
        badge: 'الأكثر مبيعاً',
        imageAlt: 'صينية كنافة نابلسية وسط الحجم',
      },
      {
        sku: 'ar-02',
        name: 'بقلاوة مشكّلة – كيلو',
        description: 'أصابع وبلورية وعش البلبل، محشية جوز وفستق حلبي ومقلية بالسمنة البلدية.',
        priceShekels: '75',
        categoryKey: 'baqlawa',
        available: true,
        imageAlt: 'علبة بقلاوة مشكّلة بوزن كيلو',
      },
      {
        sku: 'ar-03',
        name: 'ضيافة أفراح – 100 قطعة',
        description: 'تشكيلة حلو عربي بعلب ضيافة جاهزة. الطلب بدو حجز قبل ثلاث أيام.',
        priceShekels: '420',
        categoryKey: 'munasabat',
        available: true,
        imageAlt: 'علب ضيافة أفراح فيها حلو عربي مشكّل',
      },
    ],
    testimonials: [
      {
        name: 'نادر زيد',
        text: 'طلبنا ضيافة العرس من عندهم، وصلت بوقتها وبنفس اللي اتفقنا عليه بالضبط.',
      },
    ],
    overrides: {
      // Two requests a month was not enough for a shop that changes its board every season.
      features: [{ key: 'change_requests_per_month', value: 4 }],
    },
    changeRequests: [
      {
        capabilityKey: 'announcements_board',
        payload: {
          announcements: [
            {
              title: 'عرض رمضان',
              body: 'خصم 20% على كل الحلو العربي طول الشهر.',
              published: true,
              sort: 0,
            },
          ],
        },
        note: 'بدنا نعلّق إعلان عرض رمضان على الصفحة الرئيسية.',
        decision: 'rejected',
        decisionNote: 'الإعلان بيحكي عن عرض بيبدأ بعد شهرين — بنرجع نعلّقه بأوانه.',
      },
    ],
    lifecycle: { state: 'active' },
    subscriptionPayment: { method: 'bank_transfer', note: 'اشتراك سنوي، حوالة بنكية.' },
  },
  {
    slug: 'bayt-alqumash',
    name: 'بيت القماش',
    tagline: 'أقمشة بالمتر ومستلزمات خياطة',
    about:
      'محل أقمشة بيشتغل مع الخياطات وبيوت الأفراح بالمنطقة من أكثر من عشرين سنة. عندنا قطن وكتان وحرير وشيفون، والقص بالمتر قدامك على الطاولة.',
    address: 'السوق التجاري، برطعة الشرقية',
    phone: '04-2456621',
    whatsapp: '+970599670481',
    email: 'info@bayt-alqumash.example',
    hours: 'السبت – الخميس: 9:00 صباحاً – 7:00 مساءً',
    ownerName: 'فاطمة قبها',
    ownerEmail: 'fatima@bayt-alqumash.example',
    planKey: 'store',
    billingPeriod: 'monthly',
    templateKey: 'neon-souq',
    // Four days out: this is the account the "الاشتراكات القاربة على الانتهاء" call list exists for.
    periodEndInDays: 4,
    imagePack: 'clothing',
    colors: { mode: 'custom', primary: '#7C2D6B', secondary: '#D9A441', background: '#FBF7F4' },
    map: { lat: '32.4726', lng: '35.1055', query: 'السوق التجاري، برطعة الشرقية' },
    announcementBar: { text: 'وصلنا أقمشة صيف جديدة — تعالوا شوفوا قبل ما تخلص' },
    categories: [
      { key: 'aqmisha', name: 'أقمشة بالمتر' },
      { key: 'khiyata', name: 'مستلزمات خياطة' },
    ],
    products: [
      {
        sku: 'bq-01',
        name: 'قماش قطن مصري – المتر',
        description: 'قطن 100% عرض 150 سم، بيتحمّل الغسيل وما بينكمش. متوفر بعشر ألوان.',
        priceShekels: '38',
        categoryKey: 'aqmisha',
        available: true,
        imageAlt: 'طاقة قماش قطن مصري بعرض متر ونص',
      },
      {
        sku: 'bq-02',
        name: 'شيفون سادة – المتر',
        description: 'شيفون خفيف بيستعمل للطرحات وفساتين السهرة، عرض 140 سم.',
        priceShekels: '26',
        categoryKey: 'aqmisha',
        available: true,
        badge: 'جديد',
        imageAlt: 'طاقة قماش شيفون سادة',
      },
      {
        sku: 'bq-03',
        name: 'كتان مطرّز – المتر',
        description: 'كتان بتطريز يدوي على الحاشية، بينفع للأثواب والجلاليب.',
        priceShekels: '64',
        categoryKey: 'aqmisha',
        available: false,
        imageAlt: 'قماش كتان مطرّز بتطريز يدوي',
      },
      {
        sku: 'bq-04',
        name: 'علبة خيطان مشكّلة – 24 لون',
        description: 'خيطان بوليستر متينة بألوان مرتبة داخل علبة بلاستيك.',
        priceShekels: '45',
        categoryKey: 'khiyata',
        available: true,
        imageAlt: 'علبة خيطان خياطة فيها أربعة وعشرين لون',
      },
    ],
    testimonials: [
      {
        name: 'سعاد جرادات',
        text: 'بشتري منهم قماش الأثواب من سنين. القص مضبوط والسعر ما بيتغير من محل لمحل.',
      },
    ],
    overrides: {
      /**
       * Their colours are managed by us. They changed the palette four times in a week and the
       * storefront failed contrast twice, so the switch moved to the platform side — which is
       * exactly the state the "اطلب تعديل" flow exists for, and why they have an open request.
       */
      capabilities: [{ key: 'colors', patch: { editableBy: 'admin' } }],
    },
    domain: { hostname: 'baytalqumash.example', status: 'pending' },
    changeRequests: [
      {
        capabilityKey: 'colors',
        payload: { mode: 'preset', presetKey: 'bahr' },
        note: 'بدنا نرجع على الألوان الزرقاء اللي كانت قبل، بتناسب صور القماش أكثر.',
        decision: 'open',
      },
    ],
    lifecycle: { state: 'active' },
  },
  {
    slug: 'anwar-electric',
    name: 'أنوار للكهربائيات',
    tagline: 'إنارة وعدد كهربائية للبيت والورشة',
    about:
      'محل كهربائيات بيخدم البيوت والمقاولين بالمنطقة. عندنا إنارة ليد وكوابل وقواطع وعدد يدوية، وبنركّب ونستشير قبل ما تشتري.',
    address: 'شارع الجلمة، برطعة الشرقية',
    phone: '04-2458830',
    whatsapp: '+970599318842',
    email: 'sales@anwar-electric.example',
    hours: 'السبت – الخميس: 7:30 صباحاً – 6:00 مساءً',
    ownerName: 'أنور قبها',
    ownerEmail: 'anwar@anwar-electric.example',
    planKey: 'store',
    billingPeriod: 'yearly',
    templateKey: 'warsheh',
    periodEndInDays: 300,
    imagePack: 'industrial',
    colors: { mode: 'preset', presetKey: 'fulath' },
    map: { lat: '32.4703', lng: '35.1088', query: 'شارع الجلمة، برطعة الشرقية' },
    announcements: [
      {
        title: 'خدمة تركيب داخل برطعة',
        body: 'بنركّب الإنارة والقواطع بنفس اليوم لطلبات فوق 500 شيكل.',
      },
    ],
    social: [{ platform: 'instagram', url: 'https://www.instagram.com/anwar.electric.example' }],
    categories: [
      { key: 'idaa', name: 'إنارة' },
      { key: 'adawat', name: 'عدد وأدوات' },
    ],
    products: [
      {
        sku: 'ae-01',
        name: 'كشاف ليد 50 واط – ضوء أبيض',
        description: 'كشاف خارجي مقاوم للماء بدرجة IP65، ضمان سنتين.',
        priceShekels: '89',
        categoryKey: 'idaa',
        available: true,
        badge: 'الأكثر مبيعاً',
        imageAlt: 'كشاف ليد خارجي بقوة خمسين واط',
      },
      {
        sku: 'ae-02',
        name: 'شريط ليد 5 متر – أصفر دافي',
        description: 'شريط لاصق بمحوّل جاهز، بينفع للجبس والمطابخ.',
        priceShekels: '55',
        categoryKey: 'idaa',
        available: true,
        imageAlt: 'لفة شريط ليد بطول خمسة أمتار',
      },
      {
        sku: 'ae-03',
        name: 'قاطع كهرباء 32 أمبير',
        description: 'قاطع أوتوماتيكي أحادي الفاز، مطابق للمواصفة الأوروبية.',
        priceShekels: '34',
        categoryKey: 'adawat',
        available: true,
        imageAlt: 'قاطع كهرباء أوتوماتيكي بقوة اثنين وثلاثين أمبير',
      },
      {
        sku: 'ae-04',
        name: 'شنطة عدة كهربائي – 28 قطعة',
        description: 'مفكات معزولة وكماشة وقياس فولت، داخل شنطة قماش متينة.',
        priceShekels: '210',
        categoryKey: 'adawat',
        available: true,
        imageAlt: 'شنطة عدة كهربائي فيها ثمانية وعشرين قطعة',
      },
    ],
    testimonials: [
      {
        name: 'محمد أبو مخ',
        text: 'أخذت منهم إنارة البيت كلها. نصحوني بالقياس الصح ووفّروا عليّ مصاري.',
      },
    ],
    overrides: {
      // Sold as an add-on: they publish to Google and wanted the SEO fields without paying احترافي.
      features: [{ key: 'seo_tools', value: true }],
    },
    domain: { hostname: 'anwar-electric.example', status: 'verified' },
    lifecycle: { state: 'active' },
    subscriptionPayment: { method: 'bank_transfer', note: 'اشتراك سنوي، حوالة بنكية.' },
  },
  {
    slug: 'alsharq-mobile',
    name: 'الشرق موبايل',
    tagline: 'أجهزة وإكسسوارات وصيانة خلوي',
    about:
      'محل خلويات بيبيع أجهزة جديدة ومستعملة وبيصلّح شاشات وبطاريات بنفس اليوم. كل جهاز بيطلع من عنا بفاتورة وضمان مكتوب.',
    address: 'شارع السوق، برطعة الشرقية',
    phone: '04-2450099',
    whatsapp: '+970569443015',
    email: 'shop@alsharq-mobile.example',
    hours: 'السبت – الخميس: 10:00 صباحاً – 10:00 ليلاً · الجمعة: 4:00 – 10:00 مساءً',
    ownerName: 'وسام قبها',
    ownerEmail: 'wisam@alsharq-mobile.example',
    planKey: 'pro',
    billingPeriod: 'monthly',
    templateKey: 'neon-souq',
    periodEndInDays: 21,
    imagePack: 'clothing',
    colors: { mode: 'preset', presetKey: 'laylī' },
    map: { lat: '32.4721', lng: '35.1049', query: 'شارع السوق، برطعة الشرقية' },
    announcementBar: {
      text: 'تصليح الشاشات بنفس اليوم — بتجيب الجهاز الصبح وبتستلمه المسا',
    },
    announcements: [
      {
        title: 'ضمان سنة على البطاريات',
        body: 'كل بطارية بنركّبها عليها ضمان سنة كاملة بفاتورة المحل.',
      },
    ],
    social: [
      { platform: 'facebook', url: 'https://www.facebook.com/alsharq.mobile.example' },
      { platform: 'instagram', url: 'https://www.instagram.com/alsharq.mobile.example' },
    ],
    categories: [
      { key: 'ajhiza', name: 'أجهزة' },
      { key: 'ekssesswar', name: 'إكسسوارات' },
      { key: 'siyana', name: 'قطع صيانة' },
    ],
    products: [
      {
        sku: 'sm-01',
        name: 'شاحن سريع 33 واط مع كبل',
        description: 'شاحن أصلي بمنفذ USB-C، بيشحن البطارية لنص ساعة تقريباً.',
        priceShekels: '75',
        categoryKey: 'ekssesswar',
        available: true,
        badge: 'الأكثر مبيعاً',
        imageAlt: 'شاحن سريع بقوة ثلاثة وثلاثين واط مع كبل',
      },
      {
        sku: 'sm-02',
        name: 'سماعة بلوتوث لاسلكية',
        description: 'سماعة أذن لاسلكية مع علبة شحن، بتشتغل ست ساعات متواصلة.',
        priceShekels: '145',
        categoryKey: 'ekssesswar',
        available: true,
        imageAlt: 'سماعة بلوتوث لاسلكية داخل علبة الشحن',
      },
      {
        sku: 'sm-03',
        name: 'شاشة حماية زجاجية – تركيب مجاني',
        description: 'زجاج مقوّى 9H، والتركيب عنا بالمحل بدون فقاعات.',
        priceShekels: '30',
        categoryKey: 'ekssesswar',
        available: true,
        imageAlt: 'شاشة حماية زجاجية لجهاز خلوي',
      },
      {
        sku: 'sm-04',
        name: 'بطارية بديلة مع التركيب',
        description: 'بطارية جديدة بضمان سنة، التركيب بياخد نص ساعة بالمحل.',
        priceShekels: '190',
        categoryKey: 'siyana',
        available: true,
        imageAlt: 'بطارية خلوي بديلة جاهزة للتركيب',
      },
    ],
    testimonials: [
      {
        name: 'إياد قبها',
        text: 'كسرت الشاشة الصبح واستلمت الجهاز نفس اليوم. سعر واضح من الأول بدون مفاجآت.',
      },
      {
        name: 'رنا صبيحات',
        text: 'اشتريت سماعة من عندهم وطلعت فيها مشكلة، بدّلوها بدون نقاش.',
      },
    ],
    overrides: {
      features: [{ key: 'products_limit', value: 2_000 }],
    },
    domain: { hostname: 'alsharqmobile.example', status: 'active' },
    selling: {
      instructions:
        'بتقدر تدفع نقداً بالمحل أو حوالة بنكية. بنتصل فيك نأكّد الطلب قبل ما نجهّزه.',
    },
    orders: [
      {
        sku: 'sm-01',
        quantity: 1,
        customerName: 'خالد قبها',
        customerPhone: '+970599112084',
        outcome: 'fulfilled',
        method: 'cash',
      },
      {
        sku: 'sm-04',
        quantity: 1,
        customerName: 'ليلى عوض',
        customerPhone: '+970568994120',
        note: 'الجهاز آيفون، بدي أعرف إذا القطعة أصلية.',
        outcome: 'paid',
        method: 'bank_transfer',
      },
      {
        sku: 'sm-02',
        quantity: 2,
        customerName: 'أمجد زيد',
        customerPhone: '+970597330761',
        outcome: 'pending',
      },
      {
        sku: 'sm-03',
        quantity: 1,
        customerName: 'مها قبها',
        customerPhone: '+970566201884',
        outcome: 'cancelled',
      },
    ],
    lifecycle: { state: 'active' },
    subscriptionPayment: { method: 'cash', note: 'اشتراك الشهر، مقبوض نقداً.' },
  },
  {
    slug: 'warshet-alalamnyom',
    name: 'ورشة الألمنيوم الحديثة',
    tagline: 'أبواب وشبابيك ومطابخ ألمنيوم على القياس',
    about:
      'ورشة بتشتغل على القياس من سنة 2004: أبواب وشبابيك ومطابخ وقواطع حمّامات. بنجي نقيس عندك بالبيت، وبنركّب بعد الاتفاق على الرسمة والسعر.',
    address: 'المنطقة الصناعية، برطعة الشرقية',
    phone: '04-2457412',
    whatsapp: '+970599885530',
    email: 'workshop@warshet-alalamnyom.example',
    hours: 'السبت – الخميس: 7:00 صباحاً – 5:00 مساءً',
    ownerName: 'زياد قبها',
    ownerEmail: 'ziad@warshet-alalamnyom.example',
    planKey: 'pro',
    billingPeriod: 'yearly',
    templateKey: 'warsheh',
    periodEndInDays: 210,
    imagePack: 'industrial',
    colors: { mode: 'custom', primary: '#F59E0B', secondary: '#7A8494', background: '#14181D' },
    map: { lat: '32.4689', lng: '35.1102', query: 'المنطقة الصناعية، برطعة الشرقية' },
    categories: [
      { key: 'abwab', name: 'أبواب وشبابيك' },
      { key: 'matabekh', name: 'مطابخ ألمنيوم' },
    ],
    products: [
      {
        sku: 'wa-01',
        name: 'شباك ألمنيوم منزلق – متر مربع',
        description: 'قطاع ألمنيوم مقاوم للصدأ مع زجاج دبل، السعر للمتر المربع قبل التركيب.',
        priceShekels: '380',
        categoryKey: 'abwab',
        available: true,
        imageAlt: 'شباك ألمنيوم منزلق بزجاج مزدوج',
      },
      {
        sku: 'wa-02',
        name: 'باب حمّام ألمنيوم',
        description: 'باب كامل مع الإطار والمقبض، بيتركّب بنفس اليوم.',
        priceShekels: '620',
        categoryKey: 'abwab',
        available: true,
        badge: 'عرض',
        imageAlt: 'باب حمّام ألمنيوم مع إطاره',
      },
      {
        sku: 'wa-03',
        name: 'مطبخ ألمنيوم – المتر الطولي',
        description: 'خزائن ألمنيوم بمفصلات هيدروليك، الرسمة والقياس على حساب المحل.',
        priceShekels: '950',
        categoryKey: 'matabekh',
        available: true,
        imageAlt: 'خزائن مطبخ ألمنيوم بلون فضي',
      },
    ],
    testimonials: [
      {
        name: 'عبد الله جرادات',
        text: 'ركّبوا مطبخ البيت كامل بأسبوع، والقياسات طلعت مضبوطة من أول مرة.',
      },
    ],
    overrides: {
      /**
       * The layout is ours to arrange. They reordered the home page onto a hero-less shop twice,
       * so the capability moved to the admin side — an احترافي tenant that is deliberately not
       * on the plan default, which is the whole point of the per-tenant axis.
       */
      capabilities: [{ key: 'sections_layout', patch: { editableBy: 'admin' } }],
      features: [{ key: 'push_notifications', value: false }],
    },
    lifecycle: { state: 'active' },
  },
  {
    slug: 'saydaliyat-albalad',
    name: 'صيدلية البلد',
    tagline: 'دواء ومستحضرات عناية ونصيحة صيدلاني',
    about:
      'صيدلية بتخدم أهل البلد من سنة 2011. بنوفّر الأدوية الموصوفة ومستحضرات العناية وحليب الأطفال، وبنرد على استفساراتك على الواتساب.',
    address: 'الشارع الرئيسي، برطعة الشرقية',
    phone: '04-2452340',
    whatsapp: '+970599760112',
    email: 'pharmacy@saydaliyat-albalad.example',
    hours: 'السبت – الخميس: 8:00 صباحاً – 9:00 مساءً',
    ownerName: 'رائد قبها',
    ownerEmail: 'raed@saydaliyat-albalad.example',
    planKey: 'basic',
    billingPeriod: 'monthly',
    templateKey: 'diwan',
    // Already lapsed, then suspended below — this is the account with a live export link.
    periodEndInDays: -12,
    imagePack: 'food',
    colors: { mode: 'preset', presetKey: 'bahr' },
    categories: [
      { key: 'inaya', name: 'عناية ومستحضرات' },
      { key: 'atfal', name: 'مستلزمات أطفال' },
    ],
    products: [
      {
        sku: 'sb-01',
        name: 'كريم مرطّب لليدين – 100 مل',
        description: 'كريم بجليسرين وشيا، مناسب للبشرة الجافة بالشتاء.',
        priceShekels: '24',
        categoryKey: 'inaya',
        available: true,
        imageAlt: 'أنبوب كريم مرطّب لليدين سعة مئة مليلتر',
      },
      {
        sku: 'sb-02',
        name: 'واقي شمس للأطفال – 50 مل',
        description: 'حماية عالية، خالي من العطور ومناسب للبشرة الحساسة.',
        priceShekels: '58',
        categoryKey: 'atfal',
        available: true,
        imageAlt: 'عبوة واقي شمس للأطفال سعة خمسين مليلتر',
      },
      {
        sku: 'sb-03',
        name: 'ميزان حرارة رقمي',
        description: 'قراءة بعشر ثواني مع تنبيه صوتي، بيشتغل ببطارية بديلة.',
        priceShekels: '39',
        categoryKey: 'inaya',
        available: true,
        imageAlt: 'ميزان حرارة رقمي بشاشة صغيرة',
      },
    ],
    testimonials: [
      {
        name: 'سميرة قبها',
        text: 'بسألهم على الواتساب وبيردوا بسرعة، وبيحجزوا الدوا لحد ما أوصل.',
      },
    ],
    lifecycle: { state: 'suspended' },
  },
  {
    slug: 'mafrooshat-alsalam',
    name: 'مفروشات السلام',
    tagline: 'كنب وغرف نوم وسجاد',
    about:
      'معرض مفروشات بيبيع كنب وغرف نوم وسجاد، مع تقسيط داخلي بدون بنك. البضاعة موجودة بالمعرض وبتقدر تشوفها قبل ما تشتري.',
    address: 'مدخل برطعة الشرقية',
    phone: '04-2459006',
    whatsapp: '+970598220741',
    email: 'showroom@mafrooshat-alsalam.example',
    hours: 'السبت – الخميس: 9:00 صباحاً – 8:00 مساءً',
    ownerName: 'سلام قبها',
    ownerEmail: 'salam@mafrooshat-alsalam.example',
    planKey: 'store',
    billingPeriod: 'monthly',
    templateKey: 'neon-souq',
    // Lapsed long ago and suspended with a three-day window: the "قيد الحذف" list needs a top row.
    periodEndInDays: -40,
    imagePack: 'clothing',
    colors: { mode: 'custom', primary: '#B45309', secondary: '#4B5563', background: '#FAF7F2' },
    categories: [
      { key: 'kanab', name: 'كنب وطقم جلوس' },
      { key: 'ghuraf', name: 'غرف نوم' },
    ],
    products: [
      {
        sku: 'ms-01',
        name: 'طقم كنب 7 مقاعد',
        description: 'هيكل خشب زان مع إسفنج عالي الكثافة، القماش على اختيارك.',
        priceShekels: '4200',
        categoryKey: 'kanab',
        available: true,
        imageAlt: 'طقم كنب من سبع مقاعد بقماش فاتح',
      },
      {
        sku: 'ms-02',
        name: 'غرفة نوم كاملة',
        description: 'تخت وخزانة وتسريحة وكومودينتين، مع التوصيل والتركيب.',
        priceShekels: '7800',
        categoryKey: 'ghuraf',
        available: true,
        imageAlt: 'غرفة نوم كاملة بلون بني فاتح',
      },
      {
        sku: 'ms-03',
        name: 'سجادة 200×300 سم',
        description: 'سجادة تركية بوبر قصير، سهلة التنظيف وما بتنسل.',
        priceShekels: '640',
        categoryKey: 'kanab',
        available: true,
        imageAlt: 'سجادة تركية بقياس مترين في ثلاثة أمتار',
      },
    ],
    testimonials: [
      {
        name: 'أحمد عوض',
        text: 'أخذت غرفة النوم بالتقسيط ووصلت بوقتها. التركيب كان على حسابهم.',
      },
    ],
    lifecycle: { state: 'suspended', retentionDays: 3 },
  },
  {
    slug: 'ahdhiyat-alnajah',
    name: 'أحذية النجاح',
    tagline: 'أحذية رجالي ونسائي وأطفال',
    about:
      'محل أحذية بيشتغل من 1995 على مبدأ الجلد الأصلي والسعر الثابت. عندنا مقاسات كاملة للمدارس وأحذية شغل مقاومة للانزلاق.',
    address: 'شارع المدارس، برطعة الشرقية',
    phone: '04-2454418',
    whatsapp: '+970597114063',
    email: 'shop@ahdhiyat-alnajah.example',
    hours: 'السبت – الخميس: 9:00 صباحاً – 8:00 مساءً',
    ownerName: 'نجاح قبها',
    ownerEmail: 'najah@ahdhiyat-alnajah.example',
    planKey: 'basic',
    billingPeriod: 'yearly',
    templateKey: 'diwan',
    periodEndInDays: -20,
    imagePack: 'clothing',
    colors: { mode: 'preset', presetKey: 'sahra' },
    categories: [
      { key: 'madares', name: 'أحذية مدارس' },
      { key: 'shughul', name: 'أحذية شغل' },
    ],
    products: [
      {
        sku: 'an-01',
        name: 'حذاء مدرسي جلد – مقاسات 30-38',
        description: 'جلد طبيعي مع نعل مرن، بيتحمّل سنة دراسية كاملة.',
        priceShekels: '120',
        categoryKey: 'madares',
        available: true,
        badge: 'الأكثر مبيعاً',
        imageAlt: 'حذاء مدرسي أسود من الجلد الطبيعي',
      },
      {
        sku: 'an-02',
        name: 'بوط شغل مقاوم للانزلاق',
        description: 'نعل مضاد للزحلقة ومقدمة حديد، مناسب للورش والمخازن.',
        priceShekels: '185',
        categoryKey: 'shughul',
        available: true,
        imageAlt: 'بوط شغل بمقدمة حديد ونعل مقاوم للانزلاق',
      },
      {
        sku: 'an-03',
        name: 'صندل أطفال صيفي',
        description: 'خفيف وبيتغسل بالماء، بأربع ألوان ومقاسات صغيرة.',
        priceShekels: '65',
        categoryKey: 'madares',
        available: false,
        imageAlt: 'صندل أطفال صيفي بلون أزرق',
      },
    ],
    testimonials: [
      {
        name: 'وفاء قبها',
        text: 'بشتري أحذية المدرسة للولاد من عندهم كل سنة. بيدوموا وبيبدّلوا المقاس إذا ضيّق.',
      },
    ],
    // Suspended, then given three more weeks after the owner called — the extension counter moves.
    lifecycle: { state: 'suspended', extendRetentionDays: 21 },
  },
  {
    slug: 'mahmasat-albun',
    name: 'محمصة البن الذهبي',
    tagline: 'بن محمّص على الطلب وقهوة مختصة',
    about:
      'محمصة صغيرة بتحمّص البن على دفعات صغيرة كل يوم. بنطحن قدامك حسب طريقة تحضيرك، وبنشحن للبيوت داخل المنطقة.',
    address: 'شارع السوق، برطعة الشرقية',
    phone: '04-2451765',
    whatsapp: '+970599044318',
    email: 'roastery@mahmasat-albun.example',
    hours: 'السبت – الخميس: 8:00 صباحاً – 8:00 مساءً',
    ownerName: 'باسل قبها',
    ownerEmail: 'basel@mahmasat-albun.example',
    planKey: 'pro',
    billingPeriod: 'monthly',
    templateKey: 'diwan',
    // Nine days out: the second row on the call list, one reminder stage behind بيت القماش.
    periodEndInDays: 9,
    imagePack: 'food',
    colors: { mode: 'custom', primary: '#8C3A16', secondary: '#4F6141', background: '#FCF6EC' },
    map: { lat: '32.4715', lng: '35.1037', query: 'شارع السوق، برطعة الشرقية' },
    announcementBar: { text: 'التحميص الجديد بيطلع كل يوم الساعة 10 الصبح' },
    announcements: [
      {
        title: 'اشتراك البن الشهري',
        body: 'كيلو بن محمّص على ذوقك بيوصلك أول كل شهر، بسعر ثابت.',
      },
      {
        title: 'طحن مجاني',
        body: 'بنطحن البن قدامك حسب طريقة التحضير — إسبريسو، ركوة، أو فرنش برس.',
      },
    ],
    social: [{ platform: 'instagram', url: 'https://www.instagram.com/mahmasat.albun.example' }],
    categories: [
      { key: 'bun', name: 'بن محمّص' },
      { key: 'adawat', name: 'أدوات تحضير' },
    ],
    products: [
      {
        sku: 'mb-01',
        name: 'بن عربي مع هيل – كيلو',
        description: 'تحميص وسط مع هيل أخضر مطحون معه، على طريقة البيوت.',
        priceShekels: '96',
        categoryKey: 'bun',
        available: true,
        badge: 'الأكثر مبيعاً',
        imageAlt: 'كيس بن عربي محمّص مع الهيل بوزن كيلو',
      },
      {
        sku: 'mb-02',
        name: 'حبوب إسبريسو – 250 غرام',
        description: 'خلطة برازيلي وإثيوبي، تحميص غامق بكريما ثابتة.',
        priceShekels: '58',
        categoryKey: 'bun',
        available: true,
        imageAlt: 'علبة حبوب إسبريسو بوزن مئتين وخمسين غرام',
      },
      {
        sku: 'mb-03',
        name: 'ركوة نحاس – 4 فناجين',
        description: 'ركوة نحاس بمقبض خشب، بتوزّع الحرارة بالتساوي.',
        priceShekels: '72',
        categoryKey: 'adawat',
        available: true,
        imageAlt: 'ركوة نحاس بمقبض خشبي لأربعة فناجين',
      },
      {
        sku: 'mb-04',
        name: 'فلاتر ورقية – 100 قطعة',
        description: 'فلاتر مبيّضة بدون كلور، مقاس V60.',
        priceShekels: '26',
        categoryKey: 'adawat',
        available: true,
        imageAlt: 'علبة فلاتر قهوة ورقية فيها مئة قطعة',
      },
    ],
    testimonials: [
      {
        name: 'دعاء زيد',
        text: 'بنطلب منهم كيلو كل شهر. البن بيوصل محمّص جديد وريحته بتفرق فعلاً.',
      },
    ],
    overrides: {
      features: [{ key: 'storage_mb', value: 20_000 }],
      capabilities: [{ key: 'announcement_bar', patch: { editableBy: 'admin' } }],
    },
    lifecycle: { state: 'active' },
    subscriptionPayment: { method: 'bank_transfer', note: 'اشتراك الشهر، حوالة بنكية.' },
  },
];

const SCENARIO_SLUGS = MERCHANTS.map((merchant) => merchant.slug);

// -----------------------------------------------------------------------------
// Context builders — the same objects the request path would hand these services
// -----------------------------------------------------------------------------

/**
 * `requireAdminContext()` reads `next/headers` and a verified session, neither of which exists in a
 * script. The context itself is a plain object, so it is built by hand here exactly the way
 * `tests/integration/a1-super-admin.test.ts` builds one — and `userId` is a REAL user row, because
 * every audit row written downstream carries it as `actorUserId`.
 */
function adminContext(user: { id: string; email: string; name: string }): AdminContext {
  const actor = verifiedActor('super_admin', user.id);
  return {
    session: {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: true,
        platformRole: 'super_admin',
        twoFactorEnabled: true,
      },
      tenantId: null,
      memberRole: null,
      impersonatedBy: null,
    },
    actor,
    db: superAdminDb(actor),
    userId: user.id,
    ip: null,
    userAgent: null,
  };
}

/** The merchant's own door, for the services that belong to the shop rather than to the platform. */
function merchantContext(
  tenantId: string,
  owner: { id: string; email: string; name: string },
): MerchantContext {
  const actor = verifiedActor('owner', owner.id);
  return {
    session: {
      user: {
        id: owner.id,
        email: owner.email,
        name: owner.name,
        emailVerified: true,
        platformRole: 'user',
        twoFactorEnabled: false,
      },
      tenantId,
      memberRole: 'owner',
      impersonatedBy: null,
    },
    actor,
    tenantId,
    role: 'owner',
    db: tenantDb(tenantId, actor),
    userId: owner.id,
    ip: null,
    userAgent: null,
    isImpersonated: false,
  };
}

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

/**
 * Most merchant and admin services answer `null` for success and an `ActionState` carrying an i18n
 * key for a refusal. A refusal here is a bug in this file's data, not something to render, so it
 * stops the run with the key and the field errors printed rather than being silently skipped.
 */
function assertApplied(what: string, state: ActionState | null): void {
  if (!state) return;
  const fields = (state.fieldErrors ?? [])
    .map((error) => `${error.field}=${error.messageKey}`)
    .join(', ');
  const reason = state.messageKey ?? 'unknown';
  throw new Error(`${what} refused: ${reason}${fields ? ` (${fields})` : ''}`);
}

/** `YYYY-MM-DD`, which `dateField` reads as an Asia/Jerusalem wall-clock day. */
function dayFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Run one suspension inside a different retention window.
 *
 * `billing.suspend()` stamps `suspendedAt = new Date()` and derives `retentionUntil` from
 * `RETENTION_DAYS` at the moment it is called. A scenario cannot backdate a suspension, so the only
 * way to produce an account that is three days from deletion — WITHOUT writing `retentionUntil`
 * directly, which invariant 5 forbids and which would also skip the audit row and the export
 * scheduling — is to let the service compute a short window. `resetEnvCache()` is labelled
 * test-only; a fixture builder is the same kind of caller, and the previous value is restored
 * before the next merchant is touched.
 */
async function withRetentionDays<T>(days: number, run: () => Promise<T>): Promise<T> {
  const previous = process.env.RETENTION_DAYS;
  process.env.RETENTION_DAYS = String(days);
  resetEnvCache();

  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.RETENTION_DAYS;
    else process.env.RETENTION_DAYS = previous;
    resetEnvCache();
  }
}

function demoProductFrom(product: ScenarioProduct, categoryKey: string): DemoProduct {
  return {
    sku: product.sku,
    name: product.name,
    description: product.description,
    price: Number(product.priceShekels),
    currency: 'ILS',
    category: categoryKey,
    available: product.available,
    imageAlt: product.imageAlt,
    ...(product.badge ? { badge: product.badge } : {}),
  };
}

// -----------------------------------------------------------------------------
// The guards
// -----------------------------------------------------------------------------

/**
 * Two refusals, and the second one is why this file is not simply appended to the base seed.
 *
 * A scenario seed that silently lands on a live box is a catastrophe: it mints ten owner
 * identities, ten storefronts, audit rows and payments into a real tenant list, and nothing here
 * knows how to take them back. `NODE_ENV=production` is refused outright — there is no flag for it.
 * A database that already holds a tenant this script did not create is refused unless the operator
 * passes `--force`, which is the acknowledgement that they know whose database it is.
 */
async function assertSafeToRun(force: boolean): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'seed-scenario refuses to run with NODE_ENV=production. This script writes merchants, ' +
        'owners, payments and audit rows that nothing in the platform can undo.',
    );
  }

  const plans = await db.plan.count();
  if (plans === 0) {
    throw new Error(
      'No plans found. Run the base seed first (`pnpm db:seed`) — this script layers on top of it ' +
        'and does not create plans, templates or the super admin.',
    );
  }

  const superAdmins = await db.user.count({ where: { platformRole: 'super_admin' } });
  if (superAdmins === 0) {
    throw new Error('No super admin found. Run the base seed first (`pnpm db:seed`).');
  }

  const foreign = await db.tenant.findMany({
    where: { isDemo: false, slug: { notIn: SCENARIO_SLUGS } },
    select: { slug: true },
    take: 5,
  });

  if (foreign.length > 0 && !force) {
    throw new Error(
      `This database already holds ${foreign.length}+ tenant(s) this script did not create ` +
        `(${foreign.map((tenant) => tenant.slug).join(', ')}). ` +
        'Refusing to touch it. Pass --force only if you are certain it is a sandbox.',
    );
  }
}

// -----------------------------------------------------------------------------
// Building one merchant
// -----------------------------------------------------------------------------

interface PlanPrices {
  monthly: number;
  yearly: number;
}

interface BuiltMerchant {
  slug: string;
  name: string;
  planKey: string;
  state: string;
  ownerEmail: string;
  storefrontUrl: string;
  exportUrl: string | null;
}

async function buildMerchant(
  ctx: AdminContext,
  merchant: ScenarioMerchant,
  prices: Map<string, PlanPrices>,
  passwordHash: string,
  scheme: string,
): Promise<BuiltMerchant | null> {
  // Idempotency, in the base seed's own idiom: a slug that already exists is left alone entirely.
  // A merchant is built in one pass, so recovering from a half-built one means purging that tenant
  // rather than re-running over it.
  const existing = await db.tenant.findUnique({
    where: { slug: merchant.slug },
    select: { id: true },
  });
  if (existing) {
    console.log(`  ${merchant.slug}: already present, skipped`);
    return null;
  }

  const created = await createAccountFromAdmin(ctx, {
    name: merchant.name,
    slug: merchant.slug,
    address: merchant.address,
    phone: merchant.phone,
    whatsapp: merchant.whatsapp,
    ownerName: merchant.ownerName,
    ownerEmail: merchant.ownerEmail,
    planKey: merchant.planKey,
    billingPeriod: merchant.billingPeriod,
    currentPeriodEnd: dayFromNow(merchant.periodEndInDays),
    templateKey: merchant.templateKey,
    // Never true here: ten password links would put ten real messages through the mail driver for
    // ten addresses nobody owns. The credential below is what makes these accounts usable in dev.
    sendPasswordLink: false,
  });

  if ('state' in created) {
    assertApplied(`createAccount(${merchant.slug})`, created.state);
    return null;
  }

  const tenantId = created.outcome.tenantId;

  const member = await db.member.findFirst({
    where: { tenantId, role: 'owner' },
    select: { userId: true },
  });
  if (!member) throw new Error(`No owner membership for ${merchant.slug}`);

  const owner = { id: member.userId, email: merchant.ownerEmail, name: merchant.ownerName };

  /**
   * A credential the developer can actually log in with.
   *
   * `createAccountFromAdmin` deliberately creates the owner WITHOUT one — in production the only
   * way in is a reset link sent to an address the platform owner typed. A scenario database has no
   * mailbox behind these addresses, and a set of ten shops nobody can open the dashboard of is half
   * a scenario. The hash is computed once for the whole run: argon2id at ~19MB per hash, ten times
   * over, is otherwise the slowest thing this script does.
   */
  await authDb().account.upsert({
    where: { providerId_accountId: { providerId: 'credential', accountId: owner.id } },
    create: {
      userId: owner.id,
      providerId: 'credential',
      accountId: owner.id,
      password: passwordHash,
    },
    update: { password: passwordHash },
  });

  const shop = merchantContext(tenantId, owner);

  // The identity `billing.createAccount` does not carry: tagline, about, hours, email.
  assertApplied(
    `saveDetails(${merchant.slug})`,
    await saveDetails(shop, {
      name: merchant.name,
      tagline: merchant.tagline,
      about: merchant.about,
      address: merchant.address,
      phone: merchant.phone,
      whatsapp: merchant.whatsapp,
      email: merchant.email,
      hours: merchant.hours,
      logoMediaId: '',
    }),
  );

  // The home page and its nine sections — the same call A1's account screen makes.
  assertApplied(
    `seedDefaultSections(${merchant.slug})`,
    await seedDefaultSections(ctx, tenantId, merchant.name),
  );

  // Colours BEFORE any capability override: a tenant whose `colors` capability moves to the admin
  // side can no longer set its own palette, which is the point of the override and would refuse here.
  const colorResult = await saveColors(shop, merchant.colors);
  assertApplied(`saveColors(${merchant.slug})`, colorResult.state);

  if (merchant.map) {
    assertApplied(
      `saveMap(${merchant.slug})`,
      await saveMap(shop, {
        mapLat: merchant.map.lat,
        mapLng: merchant.map.lng,
        mapQuery: merchant.map.query,
      }),
    );
  }

  if (merchant.announcementBar) {
    assertApplied(
      `saveAnnouncementBar(${merchant.slug})`,
      await saveAnnouncementBar(shop, {
        enabled: true,
        text: merchant.announcementBar.text,
        link: merchant.announcementBar.link ?? '',
        startsAt: '',
        endsAt: '',
      }),
    );
  }

  for (const [index, announcement] of (merchant.announcements ?? []).entries()) {
    assertApplied(
      `saveAnnouncement(${merchant.slug})`,
      await saveAnnouncement(shop, {
        title: announcement.title,
        body: announcement.body,
        link: '',
        startsAt: '',
        endsAt: '',
        published: true,
        sort: index,
      }),
    );
  }

  if (merchant.social) {
    assertApplied(
      `saveSocialLinks(${merchant.slug})`,
      await saveSocialLinks(shop, {
        links: merchant.social.map((link) => ({ ...link, enabled: true })),
      }),
    );
  }

  // --- the catalogue ---------------------------------------------------------

  for (const [index, category] of merchant.categories.entries()) {
    assertApplied(
      `saveCategory(${merchant.slug}/${category.key})`,
      await saveCategory(shop, {
        name: category.name,
        key: category.key,
        published: true,
        // A string, because `categorySchema.sort` is `integerField`, which reads a form value.
        // `announcementSchema.sort` next door is a real number — the two forms disagree and this
        // file has to say which one it is talking to.
        sort: String(index),
      }),
    );
  }

  const categoryIdByKey = new Map<string, string>();
  for (const row of await shop.db.category.findMany({ select: { id: true, key: true } })) {
    categoryIdByKey.set(row.key, row.id);
  }

  const productIdBySku = new Map<string, string>();
  for (const product of merchant.products) {
    const result = await saveProduct(shop, {
      name: product.name,
      // Slug IS the sku, the same rule B3's builder states: an Arabic name percent-encodes into a
      // path nobody can read back to the admin over the phone.
      slug: product.sku,
      description: product.description,
      sku: product.sku,
      priceAgorot: product.priceShekels,
      categoryId: categoryIdByKey.get(product.categoryKey) ?? '',
      available: product.available,
      published: true,
      badge: product.badge ?? '',
      seoTitle: '',
      seoDescription: '',
    });
    assertApplied(`saveProduct(${merchant.slug}/${product.sku})`, result.state);
    if (result.productId) productIdBySku.set(product.sku, result.productId);
  }

  await writeProductImages(merchant, tenantId, productIdBySku, ctx);
  await writeTestimonials(merchant, tenantId, ctx);

  // --- the platform's own switches -------------------------------------------

  for (const feature of merchant.overrides?.features ?? []) {
    assertApplied(
      `setFeatureOverride(${merchant.slug}/${feature.key})`,
      await setFeatureOverride(ctx, tenantId, feature.key, feature.value),
    );
  }

  for (const capability of merchant.overrides?.capabilities ?? []) {
    assertApplied(
      `setCapabilityOverride(${merchant.slug}/${capability.key})`,
      await setCapabilityOverride(ctx, tenantId, capability.key, capability.patch),
    );
  }

  if (merchant.domain) await writeDomain(shop, merchant.domain);
  if (merchant.selling) await openCheckout(ctx, shop, merchant.selling.instructions);
  if (merchant.orders) await placeOrders(merchant, tenantId, owner, productIdBySku);
  if (merchant.changeRequests) await queueChangeRequests(ctx, shop, merchant);

  // --- money and lifecycle, every step through src/server/billing -------------

  const price = prices.get(merchant.planKey);
  if (merchant.subscriptionPayment && price) {
    await billing.recordPayment({
      tenantId,
      kind: 'subscription',
      amountAgorot: merchant.billingPeriod === 'yearly' ? price.yearly : price.monthly,
      method: merchant.subscriptionPayment.method,
      note: merchant.subscriptionPayment.note,
      recordedById: ctx.userId,
      // Deliberately no extension: the period end above is the state this scenario is describing,
      // and `extendPeriods` would move it.
    });
  }

  let exportUrl: string | null = null;

  if (merchant.lifecycle.state === 'suspended') {
    const suspension = merchant.lifecycle.retentionDays
      ? await withRetentionDays(merchant.lifecycle.retentionDays, () => billing.suspend(tenantId))
      : await billing.suspend(tenantId);

    exportUrl = exportDownloadUrl(suspension.exportDownloadToken);

    if (merchant.lifecycle.extendRetentionDays) {
      await billing.extendRetention(tenantId, {
        days: merchant.lifecycle.extendRetentionDays,
        actor: ctx.actor,
      });
    }
  }

  const label =
    merchant.lifecycle.state === 'suspended'
      ? merchant.lifecycle.retentionDays
        ? `suspended (${merchant.lifecycle.retentionDays}d to purge)`
        : merchant.lifecycle.extendRetentionDays
          ? 'suspended (retention extended)'
          : 'suspended'
      : `active (period end in ${merchant.periodEndInDays}d)`;

  console.log(`  ${merchant.slug}: ${merchant.planKey} / ${merchant.billingPeriod} — ${label}`);

  return {
    slug: merchant.slug,
    name: merchant.name,
    planKey: merchant.planKey,
    state: label,
    ownerEmail: merchant.ownerEmail,
    storefrontUrl: `${scheme}://${storefrontHost(merchant.slug)}/`,
    exportUrl,
  };
}

// -----------------------------------------------------------------------------
// The pieces with no service seam, and why each one has none
// -----------------------------------------------------------------------------

/**
 * Product photographs, through the same primitives B3's demo builder uses.
 *
 * `attachProductImage` — the merchant's own door — refuses a `Media` row that is not `ready`, and
 * `ready` is stamped by the worker after Sharp has produced the variants. A scenario seed cannot
 * wait for a queue that may not be running, so the rows are written the way `src/server/demo/build.ts`
 * writes them: `createDemoImageWriter` assembles the A3 primitives (magic-byte sniff, key layout,
 * quota accounting) and the `ProductImage` link is the same five columns. The bytes are the
 * generated SVG placeholder — no photograph is required and none exists.
 *
 * BEST EFFORT. If the storage backend refuses the bytes — R2 configured but unreachable, a
 * misconfigured bucket — the catalogue keeps its products and loses its pictures, which is a
 * scenario worth having rather than a run worth failing.
 */
async function writeProductImages(
  merchant: ScenarioMerchant,
  tenantId: string,
  productIdBySku: Map<string, string>,
  ctx: AdminContext,
): Promise<void> {
  let writer: DemoImageWriter | undefined;

  try {
    await withTenantTxn(
      tenantId,
      async (tx) => {
        const images = await createDemoImageWriter(tx, tenantId, merchant.imagePack);
        // Held outside the transaction so the catch below can take the objects back: the rows
        // unwind with the transaction, the bytes in the bucket do not.
        writer = images;

        for (const product of merchant.products) {
          const productId = productIdBySku.get(product.sku);
          if (!productId) continue;

          const image = await images.write(demoProductFrom(product, product.categoryKey));
          await tx.productImage.create({
            data: {
              tenantId,
              productId,
              mediaId: image.mediaId,
              alt: image.alt,
              sort: 0,
              isPrimary: true,
            },
          });
        }

        await images.commitUsage();
      },
      { actor: ctx.actor, timeoutMs: 60_000 },
    );

    // After the commit and never inside it: `dispatchJob` swallows a dead broker and reports.
    await writer?.enqueueProcessing();
  } catch (error) {
    await writer?.discardObjects().catch(() => undefined);
    console.warn(`  ${merchant.slug}: product images skipped — ${(error as Error).message}`);
  }
}

/**
 * Testimonials, written directly for the plain reason that nothing else writes them either:
 * `src/server/demo/build.ts` is the only producer in the codebase and it writes them on the
 * transaction too. There is no merchant screen and no admin screen behind them yet.
 */
async function writeTestimonials(
  merchant: ScenarioMerchant,
  tenantId: string,
  ctx: AdminContext,
): Promise<void> {
  if (merchant.testimonials.length === 0) return;

  await withTenantTxn(
    tenantId,
    async (tx) => {
      for (const [index, testimonial] of merchant.testimonials.entries()) {
        await tx.testimonial.create({
          data: {
            tenantId,
            name: testimonial.name,
            text: testimonial.text,
            sort: index,
            published: true,
          },
        });
      }
    },
    { actor: ctx.actor },
  );
}

/**
 * A custom domain in each of the three states the admin screens distinguish.
 *
 * `pending` is the merchant service verbatim. The step to `verified` is the one write here with no
 * seam: `verifyDomain` proves ownership with live queries against 1.1.1.1 and 8.8.8.8, and a
 * hostname under the reserved `.example` TLD will never answer one — so the columns it would set on
 * success are set here instead, and nothing else about the row is invented. `active` then goes
 * through `decideDomainAsk`, which is the real promotion: it is Caddy's on-demand-TLS ask, it is
 * idempotent, and it emits `domain.activated` and drops the hostname cache exactly as it would in
 * production.
 */
async function writeDomain(
  shop: MerchantContext,
  domain: { hostname: string; status: 'pending' | 'verified' | 'active' },
): Promise<void> {
  assertApplied(
    `addDomain(${domain.hostname})`,
    await addDomain(shop, { hostname: domain.hostname }),
  );
  if (domain.status === 'pending') return;

  const now = new Date();
  await shop.db.domain.updateMany({
    where: { tenantId: shop.tenantId, hostname: domain.hostname, status: 'pending' },
    data: { status: 'verified', verifiedAt: now, lastCheckedAt: now, failureReason: null },
  });

  if (domain.status === 'verified') return;

  const decision = await decideDomainAsk(domain.hostname);
  if (!decision.allow) {
    throw new Error(`domain-ask refused ${domain.hostname}: ${decision.reason}`);
  }
}

/**
 * The checkout, both halves.
 *
 * The platform owns the provider and its keys; the merchant owns the selling switch and the Arabic
 * instructions their customer reads. `manual` is the only adapter that is `active` in V1 and it
 * declares no credential fields, which is exactly how a shop in Bartaa is paid: the customer sends
 * the order, the merchant calls them, and the money changes hands over a counter.
 */
async function openCheckout(
  ctx: AdminContext,
  shop: MerchantContext,
  instructions: string,
): Promise<void> {
  assertApplied(
    'saveGatewayCredentials',
    await saveGatewayCredentials(ctx, shop.tenantId, {
      provider: 'manual',
      credentials: {},
      instructions,
    }),
  );
  assertApplied(
    'setAccountGatewayEnabled',
    await setAccountGatewayEnabled(ctx, shop.tenantId, 'manual', true),
  );
  assertApplied('savePayments', await savePayments(shop, { sellingEnabled: true, instructions }));
}

/**
 * Orders as a customer places them and as the merchant then moves them.
 *
 * `placeOrder` takes a product slug and a quantity and NOTHING that touches money — the price comes
 * from the database — and `changeOrderStatus` records the `Payment` through billing when the order
 * settles. Both are the production paths; the only thing invented here is the customer.
 */
async function placeOrders(
  merchant: ScenarioMerchant,
  tenantId: string,
  owner: { id: string },
  productIdBySku: Map<string, string>,
): Promise<void> {
  const actor = verifiedActor('owner', owner.id);

  for (const order of merchant.orders ?? []) {
    if (!productIdBySku.has(order.sku)) continue;

    const placed = await placeOrder({
      tenantId,
      productSlug: order.sku,
      quantity: order.quantity,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      ...(order.note ? { customerNote: order.note } : {}),
    });

    if (!placed.ok) {
      console.warn(`  ${merchant.slug}: order for ${order.sku} rejected (${placed.reason})`);
      continue;
    }

    if (order.outcome === 'pending') continue;

    const move = async (to: 'paid' | 'fulfilled' | 'cancelled'): Promise<void> => {
      const result = await changeOrderStatus({
        tenantId,
        orderId: placed.orderId,
        to,
        actor,
        actorUserId: owner.id,
        ip: null,
        userAgent: null,
        ...(to === 'paid'
          ? { settlement: { method: order.method ?? 'cash', amountAgorot: placed.totalAgorot } }
          : {}),
      });
      if (!result.ok) {
        throw new Error(`order ${placed.number} could not move to ${to}: ${result.reason}`);
      }
    };

    if (order.outcome === 'cancelled') {
      await move('cancelled');
      continue;
    }

    await move('paid');
    if (order.outcome === 'fulfilled') await move('fulfilled');
  }
}

/**
 * The change-request queue, with history rather than only a backlog.
 *
 * The merchant submits through the same function B2's "اطلب تعديل" button calls — which refuses a
 * capability the merchant CAN already edit, so every request below sits on a capability that is
 * `editable_by = admin` either by plan default or by the override applied a few lines earlier. The
 * decision then goes through A1's applier, which writes the payload verbatim.
 */
async function queueChangeRequests(
  ctx: AdminContext,
  shop: MerchantContext,
  merchant: ScenarioMerchant,
): Promise<void> {
  for (const request of merchant.changeRequests ?? []) {
    const submitted = await submitChangeRequest(shop, {
      capabilityKey: request.capabilityKey,
      payload: request.payload,
      note: request.note,
    });

    if (submitted.status !== 'ok') {
      throw new Error(
        `submitChangeRequest(${merchant.slug}/${request.capabilityKey}) refused: ${submitted.messageKey}`,
      );
    }

    if (request.decision === 'open') continue;

    const row = await shop.db.changeRequest.findFirst({
      where: { capabilityKey: request.capabilityKey, status: 'open' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!row) throw new Error(`change request for ${merchant.slug} vanished before its decision`);

    assertApplied(
      `${request.decision}ChangeRequest(${merchant.slug})`,
      request.decision === 'applied'
        ? await applyChangeRequest(ctx, row.id, request.decisionNote)
        : await rejectChangeRequest(ctx, row.id, request.decisionNote),
    );
  }
}

// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const scheme = process.env.PUBLIC_SCHEME ?? 'http';
  const password = process.env.SEED_MERCHANT_PASSWORD ?? 'Merchant!2026';

  console.log('Seeding the Souq Bartaa scenario…');
  await assertSafeToRun(force);

  const superAdmin = await db.user.findFirstOrThrow({
    where: { platformRole: 'super_admin' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true, name: true },
  });
  const ctx = adminContext(superAdmin);

  const prices = new Map<string, PlanPrices>();
  for (const plan of await db.plan.findMany({
    select: { key: true, priceMonthlyAgorot: true, priceYearlyAgorot: true },
  })) {
    prices.set(plan.key, { monthly: plan.priceMonthlyAgorot, yearly: plan.priceYearlyAgorot });
  }

  // One hash for every owner: argon2id costs ~19MB and a beat each time, and these ten share a
  // development password by design.
  const passwordHash = await argon2Hash(password, {
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  const built: BuiltMerchant[] = [];
  for (const merchant of MERCHANTS) {
    const result = await buildMerchant(ctx, merchant, prices, passwordHash, scheme);
    if (result) built.push(result);
  }

  if (built.length === 0) {
    console.log('Nothing new — every scenario merchant was already present.');
    return;
  }

  console.log('');
  console.log(`Built ${built.length} merchant(s). Owner password: ${password}`);
  console.log('');
  for (const merchant of built) {
    console.log(`  ${merchant.name} — ${merchant.planKey}, ${merchant.state}`);
    console.log(`    storefront: ${merchant.storefrontUrl}`);
    console.log(`    owner:      ${merchant.ownerEmail}`);
    if (merchant.exportUrl) console.log(`    export:     ${merchant.exportUrl}`);
  }
  console.log('');
  console.log('Done.');
}

await main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    /**
     * Redis has to be closed by hand, and this is not tidiness.
     *
     * `invalidateEntitlements` opens the cache connection on the first account created, and the
     * image enqueue opens the queue one; the queue connection's retry strategy backs off forever
     * by design (BullMQ blocks on BRPOPLPUSH and a retry limit would tear a worker down mid-wait).
     * A finished script holding either handle never exits — with the broker UP because the socket
     * is idle but open, and with it DOWN because ioredis is still reconnecting.
     */
    await closeQueues().catch(() => undefined);
    await closeRedis().catch(() => undefined);
    await disconnectAll();
  });
