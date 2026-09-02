import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hash } from '@node-rs/argon2';
import { getEnv } from '@/env';

/**
 * Give an imported shop a login (Q25).
 *
 *   pnpm standalone:owner
 *
 * WHY THIS EXISTS AT ALL. The backup carries `members` — who belongs to the shop — but not `users`
 * or `accounts`: a login is better-auth's, lives outside the tenant, and is shared across the
 * platform (`tenant-backup/tables.ts` says so where the decision is made). So an imported shop has
 * a membership row pointing at a user id that does not exist on this machine. This script creates
 * the user, attaches the credential, and repoints the existing owner membership at it.
 *
 * THE PASSWORD IS PRINTED ONCE AND STORED NOWHERE. It is a first-login credential on a server the
 * operator is sitting in front of; writing it to a file would leave it there forever, and mailing
 * it would need SMTP that may not be configured yet. If it is lost, run this again — the script is
 * idempotent and rotates the password rather than failing.
 *
 * ARGON2ID at the same parameters `src/server/auth` uses. A standalone deployment must not be the
 * one with weaker hashing because its bootstrap took a shortcut.
 */

async function main(): Promise<void> {
  const env = getEnv();
  const tenantId = env.SINGLE_TENANT_ID;
  if (!env.SINGLE_TENANT_MODE || !tenantId) {
    console.error('This script only runs inside a standalone bundle (SINGLE_TENANT_MODE=1).');
    process.exit(2);
  }

  const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL_MIGRATE });

  try {
    const site = await prisma.site.findUnique({
      where: { tenantId },
      select: { name: true },
    });

    // `DOMAIN` is required by `src/env.ts`, so there is no fallback to write here — the bundle's
    // .env.template ships it blank and `bootstrap.sh` refuses to continue until it is filled.
    const email = process.env.OWNER_EMAIL?.trim() || `owner@${env.DOMAIN.replace(/^www\./, '')}`;
    const password = randomBytes(12).toString('base64url');

    // OWASP baseline, matching src/server/auth.
    const passwordHash = await hash(password, {
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    const user = await prisma.user.upsert({
      where: { email },
      create: {
        email,
        name: site?.name ?? 'صاحب المتجر',
        emailVerified: true,
        platformRole: 'user',
      },
      update: { emailVerified: true },
      select: { id: true },
    });

    await prisma.account.upsert({
      where: { providerId_accountId: { providerId: 'credential', accountId: user.id } },
      create: { userId: user.id, providerId: 'credential', accountId: user.id, password: passwordHash },
      update: { password: passwordHash },
    });

    /**
     * Repoint the OWNER membership rather than adding a second one.
     *
     * The imported `members` row names a user id from the platform that does not exist here, so
     * leaving it would give the shop an owner nobody can sign in as and this new account no
     * membership at all — a dashboard that refuses its own owner, which is a bug B2 already hit
     * once and documented.
     */
    const owner = await prisma.member.findFirst({
      where: { tenantId, role: 'owner' },
      select: { id: true },
    });

    if (owner) {
      await prisma.member.update({ where: { id: owner.id }, data: { userId: user.id } });
    } else {
      await prisma.member.create({ data: { tenantId, userId: user.id, role: 'owner' } });
    }

    console.log('');
    console.log('  ===========================================================');
    console.log('   حساب صاحب المتجر جاهز — انسخ كلمة السر، ما بتنعرض مرة تانية');
    console.log('  ===========================================================');
    console.log(`   البريد:      ${email}`);
    console.log(`   كلمة السر:   ${password}`);
    console.log('  ===========================================================');
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

await main();
