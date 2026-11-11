CREATE TABLE "carrier_offer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"carrier_id" uuid NOT NULL,
	"rate_kop" bigint,
	"vat_included" boolean DEFAULT true NOT NULL,
	"vat_rate_bp" integer NOT NULL,
	"vehicle_descr" text,
	"confirmed_arrive_at" timestamp with time zone,
	"downtime_terms" text,
	"expected_downtime_kop" bigint DEFAULT 0 NOT NULL,
	"valid_until" timestamp with time zone,
	"source" text,
	"status" text DEFAULT 'quoted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	"executor" text NOT NULL,
	"vehicle_id" uuid,
	"driver_id" uuid,
	"carrier_offer_id" uuid,
	"departure_at" timestamp with time zone NOT NULL,
	"distance_m" integer NOT NULL,
	"duration_s" integer NOT NULL,
	"metrics_source" text NOT NULL,
	"toll_filtered" boolean DEFAULT false NOT NULL,
	"profile_complete" boolean DEFAULT true NOT NULL,
	"legs_estimated" boolean DEFAULT false NOT NULL,
	"stops_snapshot" jsonb NOT NULL,
	"cost_lines" jsonb NOT NULL,
	"assumptions" jsonb NOT NULL,
	"total_kop" bigint NOT NULL,
	"incomplete" boolean DEFAULT false NOT NULL,
	CONSTRAINT "plan_version_no" UNIQUE("trip_id","version_no")
);
--> statement-breakpoint
ALTER TABLE "carrier_offer" ADD CONSTRAINT "carrier_offer_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_offer" ADD CONSTRAINT "carrier_offer_trip_id_trip_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trip"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_offer" ADD CONSTRAINT "carrier_offer_carrier_id_counterparty_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."counterparty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_version" ADD CONSTRAINT "plan_version_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_version" ADD CONSTRAINT "plan_version_trip_id_trip_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trip"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_version" ADD CONSTRAINT "plan_version_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_version" ADD CONSTRAINT "plan_version_vehicle_id_vehicle_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicle"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_version" ADD CONSTRAINT "plan_version_driver_id_driver_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."driver"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_version" ADD CONSTRAINT "plan_version_carrier_offer_id_carrier_offer_id_fk" FOREIGN KEY ("carrier_offer_id") REFERENCES "public"."carrier_offer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "carrier_offer_trip_idx" ON "carrier_offer" USING btree ("trip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_version_current" ON "plan_version" USING btree ("trip_id") WHERE "plan_version"."is_current";