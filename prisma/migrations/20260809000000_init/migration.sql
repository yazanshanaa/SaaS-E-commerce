-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "platform_role" AS ENUM ('user', 'super_admin');

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "billing_period" AS ENUM ('monthly', 'yearly');

-- CreateEnum
CREATE TYPE "reminder_stage" AS ENUM ('pre_expiry_t7', 'pre_expiry_t3', 'pre_expiry_t0', 'retention_r7', 'retention_r3');

-- CreateEnum
CREATE TYPE "payment_kind" AS ENUM ('subscription', 'order', 'setup_fee', 'change_request_addon');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('pending', 'paid', 'failed', 'refunded');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('cash', 'bank_transfer', 'card', 'gateway', 'other');

-- CreateEnum
CREATE TYPE "change_request_status" AS ENUM ('open', 'applied', 'rejected');

-- CreateEnum
CREATE TYPE "capability_key" AS ENUM ('social_links', 'map_location', 'announcement_bar', 'announcements_board', 'colors', 'sections_layout');

-- CreateEnum
CREATE TYPE "editable_by" AS ENUM ('admin', 'merchant');

-- CreateEnum
CREATE TYPE "domain_kind" AS ENUM ('platform_subdomain', 'custom');

-- CreateEnum
CREATE TYPE "domain_status" AS ENUM ('pending', 'verified', 'active', 'failed');

-- CreateEnum
CREATE TYPE "media_status" AS ENUM ('pending', 'processing', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "media_variant_kind" AS ENUM ('thumb', 'card', 'full');

-- CreateEnum
CREATE TYPE "image_format" AS ENUM ('webp', 'avif', 'jpeg', 'png');

-- CreateEnum
CREATE TYPE "section_type" AS ENUM ('hero', 'products_grid', 'categories', 'about', 'gallery', 'testimonials', 'announcements', 'contact_whatsapp', 'map', 'custom_html');

-- CreateEnum
CREATE TYPE "demo_request_status" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "push_message_status" AS ENUM ('draft', 'queued', 'sending', 'sent', 'failed');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('pending', 'paid', 'fulfilled', 'cancelled', 'refunded');

-- CreateEnum
CREATE TYPE "consent_kind" AS ENUM ('analytics', 'push');

-- CreateEnum
CREATE TYPE "dsr_kind" AS ENUM ('access', 'correction', 'deletion');

-- CreateEnum
CREATE TYPE "dsr_status" AS ENUM ('received', 'in_progress', 'completed', 'rejected');

-- CreateEnum
CREATE TYPE "dsr_subject_kind" AS ENUM ('merchant', 'staff', 'visitor', 'demo_prospect');

-- CreateEnum
CREATE TYPE "notification_audience" AS ENUM ('merchant', 'super_admin');

-- CreateEnum
CREATE TYPE "notification_level" AS ENUM ('info', 'warning', 'critical');

-- CreateEnum
CREATE TYPE "webhook_delivery_status" AS ENUM ('pending', 'delivered', 'failed', 'dead');

-- CreateEnum
CREATE TYPE "tenant_state" AS ENUM ('active', 'suspended', 'purging');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "platform_role" "platform_role" NOT NULL DEFAULT 'user',
    "login_disabled" BOOLEAN NOT NULL DEFAULT false,
    "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false,
    "banned" BOOLEAN,
    "ban_reason" TEXT,
    "ban_expires" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "user_id" TEXT NOT NULL,
    "active_tenant_id" TEXT,
    "impersonated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "refresh_token_expires_at" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "two_factors" (
    "id" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "backup_codes" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT true,
    "failed_verification_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),

    CONSTRAINT "two_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "members" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "inviter_id" TEXT NOT NULL,
    "team_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price_monthly_agorot" INTEGER NOT NULL,
    "price_yearly_agorot" INTEGER NOT NULL,
    "setup_fee_agorot" INTEGER NOT NULL DEFAULT 0,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_features" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "feature_key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "plan_features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_capabilities" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "capability_key" "capability_key" NOT NULL,
    "editable_by" "editable_by" NOT NULL,
    "visible" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "plan_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templates" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "font_key" TEXT NOT NULL,
    "preview_path" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "state" "tenant_state" NOT NULL DEFAULT 'active',
    "storage_bytes_used" BIGINT NOT NULL DEFAULT 0,
    "logo" TEXT,
    "metadata" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "status" "subscription_status" NOT NULL DEFAULT 'active',
    "billing_period" "billing_period" NOT NULL DEFAULT 'monthly',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "current_period_end" TIMESTAMP(3),
    "suspended_at" TIMESTAMP(3),
    "retention_until" TIMESTAMP(3),
    "retention_extensions" INTEGER NOT NULL DEFAULT 0,
    "export_key" TEXT,
    "export_generated_at" TIMESTAMP(3),
    "export_download_token" TEXT,
    "export_first_downloaded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_reminders" (
    "subscription_id" TEXT NOT NULL,
    "stage" "reminder_stage" NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_reminders_pkey" PRIMARY KEY ("subscription_id","stage")
);

-- CreateTable
CREATE TABLE "entitlements" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "feature_key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "note" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capability_overrides" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "capability_key" "capability_key" NOT NULL,
    "editable_by" "editable_by",
    "visible" BOOLEAN,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "capability_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sites" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "template_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tagline" TEXT,
    "about" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "whatsapp" TEXT,
    "hours" TEXT,
    "email" TEXT,
    "map_lat" DOUBLE PRECISION,
    "map_lng" DOUBLE PRECISION,
    "map_query" TEXT,
    "logo_media_id" TEXT,
    "favicon_media_id" TEXT,
    "og_image_media_id" TEXT,
    "announcement_bar_enabled" BOOLEAN NOT NULL DEFAULT false,
    "announcement_bar_text" TEXT,
    "announcement_bar_link" TEXT,
    "announcement_bar_starts_at" TIMESTAMP(3),
    "announcement_bar_ends_at" TIMESTAMP(3),
    "umami_website_id" TEXT,
    "pwa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "selling_enabled" BOOLEAN NOT NULL DEFAULT false,
    "meta_title" TEXT,
    "meta_description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "theme_settings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "color_mode" TEXT NOT NULL DEFAULT 'preset',
    "preset_key" TEXT,
    "primary" TEXT NOT NULL,
    "secondary" TEXT NOT NULL,
    "background" TEXT NOT NULL,
    "surface" TEXT,
    "text" TEXT,
    "tokens" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "theme_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_links" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pages" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "meta_title" TEXT,
    "meta_description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sections" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "type" "section_type" NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "image_media_id" TEXT,
    "link" TEXT,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "sort" INTEGER NOT NULL DEFAULT 0,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "testimonials" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "rating" INTEGER,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "testimonials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "image_media_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "category_id" TEXT,
    "sku" TEXT,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price_agorot" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "available" BOOLEAN NOT NULL DEFAULT true,
    "badge" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "variants" JSONB,
    "seo_title" TEXT,
    "seo_description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_images" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "alt" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "original_name" TEXT,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "checksum" TEXT,
    "status" "media_status" NOT NULL DEFAULT 'pending',
    "alt_text" TEXT,
    "failure_reason" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_variants" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "kind" "media_variant_kind" NOT NULL,
    "format" "image_format" NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domains" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "kind" "domain_kind" NOT NULL DEFAULT 'custom',
    "status" "domain_status" NOT NULL DEFAULT 'pending',
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "verification_token" TEXT,
    "verified_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "last_checked_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demo_links" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "subscription_id" TEXT,
    "kind" "payment_kind" NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'paid',
    "amount_agorot" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "method" "payment_method",
    "note" TEXT,
    "attachment_media_id" TEXT,
    "change_request_id" TEXT,
    "order_id" TEXT,
    "provider_ref" TEXT,
    "raw_payload" JSONB,
    "paid_at" TIMESTAMP(3),
    "recorded_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_configs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "credentials_cipher" TEXT,
    "credentials_iv" TEXT,
    "credentials_tag" TEXT,
    "config" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gateway_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "capability_key" "capability_key" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "change_request_status" NOT NULL DEFAULT 'open',
    "note" TEXT,
    "decision_note" TEXT,
    "created_by_id" TEXT NOT NULL,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" "consent_kind" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "visitor_hash" TEXT NOT NULL,
    "ip_hash" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "user_agent" TEXT,
    "consent_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_messages" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "target_url" TEXT,
    "status" "push_message_status" NOT NULL DEFAULT 'draft',
    "created_by_id" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3),
    "delivered_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "order_status" NOT NULL DEFAULT 'pending',
    "customer_name" TEXT,
    "customer_phone" TEXT,
    "customer_note" TEXT,
    "total_agorot" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "placed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "product_id" TEXT,
    "name_snapshot" TEXT NOT NULL,
    "price_agorot" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "subtotal_agorot" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_counters" (
    "tenant_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_counters_pkey" PRIMARY KEY ("tenant_id","key")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "audience" "notification_audience" NOT NULL,
    "level" "notification_level" NOT NULL DEFAULT 'info',
    "key" TEXT NOT NULL,
    "data" JSONB,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "actor_role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_logs" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "actor_role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "tenant_ref" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demo_requests" (
    "id" TEXT NOT NULL,
    "business_name" TEXT,
    "address" TEXT NOT NULL,
    "whatsapp" TEXT NOT NULL,
    "requested_prefix" TEXT NOT NULL,
    "pack_key" TEXT,
    "status" "demo_request_status" NOT NULL DEFAULT 'pending',
    "created_tenant_id" TEXT,
    "ip_hash" TEXT NOT NULL,
    "note" TEXT,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "purge_after" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_tombstones" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "slug_hash" TEXT NOT NULL,
    "purged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purged_by_id" TEXT,
    "retention_extensions" INTEGER NOT NULL DEFAULT 0,
    "export_delivered_at" TIMESTAMP(3),
    "export_downloaded_at" TIMESTAMP(3),
    "reason" TEXT NOT NULL,

    CONSTRAINT "tenant_tombstones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsr_requests" (
    "id" TEXT NOT NULL,
    "subject_kind" "dsr_subject_kind" NOT NULL,
    "subject_email" TEXT,
    "subject_phone_hash" TEXT,
    "tenant_ref" TEXT,
    "kind" "dsr_kind" NOT NULL,
    "status" "dsr_status" NOT NULL DEFAULT 'received',
    "details" TEXT,
    "resolution" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "handled_by_id" TEXT,

    CONSTRAINT "dsr_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "event_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "tenant_ref" TEXT,
    "payload" JSONB NOT NULL,
    "status" "webhook_delivery_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3),
    "response_status" INTEGER,
    "error" TEXT,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_platform_role_idx" ON "users"("platform_role");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "accounts_user_id_idx" ON "accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_id_account_id_key" ON "accounts"("provider_id", "account_id");

-- CreateIndex
CREATE INDEX "verifications_identifier_idx" ON "verifications"("identifier");

-- CreateIndex
CREATE INDEX "verifications_expires_at_idx" ON "verifications"("expires_at");

-- CreateIndex
CREATE INDEX "two_factors_user_id_idx" ON "two_factors"("user_id");

-- CreateIndex
CREATE INDEX "members_tenant_id_user_id_idx" ON "members"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "members_user_id_idx" ON "members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "members_tenant_id_user_id_key" ON "members"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "invitations_tenant_id_email_idx" ON "invitations"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "invitations_email_idx" ON "invitations"("email");

-- CreateIndex
CREATE UNIQUE INDEX "plans_key_key" ON "plans"("key");

-- CreateIndex
CREATE INDEX "plan_features_plan_id_idx" ON "plan_features"("plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_features_plan_id_feature_key_key" ON "plan_features"("plan_id", "feature_key");

-- CreateIndex
CREATE INDEX "plan_capabilities_plan_id_idx" ON "plan_capabilities"("plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_capabilities_plan_id_capability_key_key" ON "plan_capabilities"("plan_id", "capability_key");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "tenants_is_demo_idx" ON "tenants"("is_demo");

-- CreateIndex
CREATE INDEX "tenants_state_idx" ON "tenants"("state");

-- CreateIndex
CREATE INDEX "tenants_created_at_idx" ON "tenants"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_tenant_id_key" ON "subscriptions"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_export_download_token_key" ON "subscriptions"("export_download_token");

-- CreateIndex
CREATE INDEX "subscriptions_tenant_id_idx" ON "subscriptions"("tenant_id");

-- CreateIndex
CREATE INDEX "subscriptions_status_current_period_end_idx" ON "subscriptions"("status", "current_period_end");

-- CreateIndex
CREATE INDEX "subscriptions_status_retention_until_idx" ON "subscriptions"("status", "retention_until");

-- CreateIndex
CREATE INDEX "subscription_reminders_tenant_id_stage_idx" ON "subscription_reminders"("tenant_id", "stage");

-- CreateIndex
CREATE INDEX "entitlements_tenant_id_feature_key_idx" ON "entitlements"("tenant_id", "feature_key");

-- CreateIndex
CREATE UNIQUE INDEX "entitlements_tenant_id_feature_key_key" ON "entitlements"("tenant_id", "feature_key");

-- CreateIndex
CREATE INDEX "capability_overrides_tenant_id_capability_key_idx" ON "capability_overrides"("tenant_id", "capability_key");

-- CreateIndex
CREATE UNIQUE INDEX "capability_overrides_tenant_id_capability_key_key" ON "capability_overrides"("tenant_id", "capability_key");

-- CreateIndex
CREATE UNIQUE INDEX "sites_tenant_id_key" ON "sites"("tenant_id");

-- CreateIndex
CREATE INDEX "sites_tenant_id_idx" ON "sites"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "theme_settings_tenant_id_key" ON "theme_settings"("tenant_id");

-- CreateIndex
CREATE INDEX "theme_settings_tenant_id_idx" ON "theme_settings"("tenant_id");

-- CreateIndex
CREATE INDEX "social_links_tenant_id_sort_idx" ON "social_links"("tenant_id", "sort");

-- CreateIndex
CREATE UNIQUE INDEX "social_links_tenant_id_platform_key" ON "social_links"("tenant_id", "platform");

-- CreateIndex
CREATE INDEX "pages_tenant_id_sort_idx" ON "pages"("tenant_id", "sort");

-- CreateIndex
CREATE UNIQUE INDEX "pages_tenant_id_slug_key" ON "pages"("tenant_id", "slug");

-- CreateIndex
CREATE INDEX "sections_tenant_id_page_id_sort_idx" ON "sections"("tenant_id", "page_id", "sort");

-- CreateIndex
CREATE INDEX "sections_page_id_idx" ON "sections"("page_id");

-- CreateIndex
CREATE INDEX "announcements_tenant_id_sort_idx" ON "announcements"("tenant_id", "sort");

-- CreateIndex
CREATE INDEX "announcements_tenant_id_starts_at_ends_at_idx" ON "announcements"("tenant_id", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "testimonials_tenant_id_sort_idx" ON "testimonials"("tenant_id", "sort");

-- CreateIndex
CREATE INDEX "categories_tenant_id_sort_idx" ON "categories"("tenant_id", "sort");

-- CreateIndex
CREATE UNIQUE INDEX "categories_tenant_id_key_key" ON "categories"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "products_tenant_id_sort_idx" ON "products"("tenant_id", "sort");

-- CreateIndex
CREATE INDEX "products_tenant_id_category_id_idx" ON "products"("tenant_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenant_id_slug_key" ON "products"("tenant_id", "slug");

-- CreateIndex
CREATE INDEX "product_images_tenant_id_product_id_sort_idx" ON "product_images"("tenant_id", "product_id", "sort");

-- CreateIndex
CREATE UNIQUE INDEX "product_images_product_id_media_id_key" ON "product_images"("product_id", "media_id");

-- CreateIndex
CREATE INDEX "media_tenant_id_status_idx" ON "media"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "media_tenant_id_created_at_idx" ON "media"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "media_tenant_id_key_key" ON "media"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "media_variants_tenant_id_media_id_idx" ON "media_variants"("tenant_id", "media_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_variants_media_id_kind_format_key" ON "media_variants"("media_id", "kind", "format");

-- CreateIndex
CREATE UNIQUE INDEX "domains_hostname_key" ON "domains"("hostname");

-- CreateIndex
CREATE INDEX "domains_tenant_id_status_idx" ON "domains"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "domains_status_idx" ON "domains"("status");

-- CreateIndex
CREATE UNIQUE INDEX "demo_links_token_key" ON "demo_links"("token");

-- CreateIndex
CREATE INDEX "demo_links_tenant_id_revoked_at_idx" ON "demo_links"("tenant_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_change_request_id_key" ON "payments"("change_request_id");

-- CreateIndex
CREATE INDEX "payments_tenant_id_kind_paid_at_idx" ON "payments"("tenant_id", "kind", "paid_at");

-- CreateIndex
CREATE INDEX "payments_tenant_id_created_at_idx" ON "payments"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "payments_subscription_id_idx" ON "payments"("subscription_id");

-- CreateIndex
CREATE INDEX "gateway_configs_tenant_id_idx" ON "gateway_configs"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_configs_tenant_id_provider_key" ON "gateway_configs"("tenant_id", "provider");

-- CreateIndex
CREATE INDEX "change_requests_tenant_id_status_created_at_idx" ON "change_requests"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "change_requests_tenant_id_created_at_idx" ON "change_requests"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "consents_tenant_id_kind_created_at_idx" ON "consents"("tenant_id", "kind", "created_at");

-- CreateIndex
CREATE INDEX "consents_tenant_id_visitor_hash_idx" ON "consents"("tenant_id", "visitor_hash");

-- CreateIndex
CREATE INDEX "push_subscriptions_tenant_id_created_at_idx" ON "push_subscriptions"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_tenant_id_endpoint_key" ON "push_subscriptions"("tenant_id", "endpoint");

-- CreateIndex
CREATE INDEX "push_messages_tenant_id_created_at_idx" ON "push_messages"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "push_messages_tenant_id_status_idx" ON "push_messages"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "orders_tenant_id_status_placed_at_idx" ON "orders"("tenant_id", "status", "placed_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_tenant_id_number_key" ON "orders"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "order_items_tenant_id_order_id_idx" ON "order_items"("tenant_id", "order_id");

-- CreateIndex
CREATE INDEX "tenant_counters_tenant_id_idx" ON "tenant_counters"("tenant_id");

-- CreateIndex
CREATE INDEX "notifications_tenant_id_audience_created_at_idx" ON "notifications"("tenant_id", "audience", "created_at");

-- CreateIndex
CREATE INDEX "notifications_tenant_id_read_at_idx" ON "notifications"("tenant_id", "read_at");

-- CreateIndex
CREATE INDEX "events_tenant_id_type_occurred_at_idx" ON "events"("tenant_id", "type", "occurred_at");

-- CreateIndex
CREATE INDEX "events_tenant_id_occurred_at_idx" ON "events"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_idx" ON "audit_logs"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_action_created_at_idx" ON "audit_logs"("tenant_id", "action", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_actor_user_id_idx" ON "audit_logs"("tenant_id", "actor_user_id");

-- CreateIndex
CREATE INDEX "platform_audit_logs_created_at_idx" ON "platform_audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "platform_audit_logs_action_created_at_idx" ON "platform_audit_logs"("action", "created_at");

-- CreateIndex
CREATE INDEX "platform_audit_logs_tenant_ref_idx" ON "platform_audit_logs"("tenant_ref");

-- CreateIndex
CREATE INDEX "demo_requests_status_created_at_idx" ON "demo_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "demo_requests_purge_after_idx" ON "demo_requests"("purge_after");

-- CreateIndex
CREATE INDEX "demo_requests_requested_prefix_idx" ON "demo_requests"("requested_prefix");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_tombstones_tenant_id_key" ON "tenant_tombstones"("tenant_id");

-- CreateIndex
CREATE INDEX "tenant_tombstones_purged_at_idx" ON "tenant_tombstones"("purged_at");

-- CreateIndex
CREATE INDEX "tenant_tombstones_slug_hash_idx" ON "tenant_tombstones"("slug_hash");

-- CreateIndex
CREATE INDEX "dsr_requests_status_received_at_idx" ON "dsr_requests"("status", "received_at");

-- CreateIndex
CREATE INDEX "dsr_requests_subject_email_idx" ON "dsr_requests"("subject_email");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_event_id_idx" ON "webhook_deliveries"("event_id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_tenant_ref_idx" ON "webhook_deliveries"("tenant_ref");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factors" ADD CONSTRAINT "two_factors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_capabilities" ADD CONSTRAINT "plan_capabilities_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_reminders" ADD CONSTRAINT "subscription_reminders_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_reminders" ADD CONSTRAINT "subscription_reminders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capability_overrides" ADD CONSTRAINT "capability_overrides_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sites" ADD CONSTRAINT "sites_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "theme_settings" ADD CONSTRAINT "theme_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_links" ADD CONSTRAINT "social_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "testimonials" ADD CONSTRAINT "testimonials_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media" ADD CONSTRAINT "media_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_variants" ADD CONSTRAINT "media_variants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_variants" ADD CONSTRAINT "media_variants_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domains" ADD CONSTRAINT "domains_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demo_links" ADD CONSTRAINT "demo_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_change_request_id_fkey" FOREIGN KEY ("change_request_id") REFERENCES "change_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_configs" ADD CONSTRAINT "gateway_configs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_messages" ADD CONSTRAINT "push_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_counters" ADD CONSTRAINT "tenant_counters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

