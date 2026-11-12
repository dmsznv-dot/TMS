CREATE TABLE "acceptance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"trip_cargo_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"accepted_milli" bigint NOT NULL,
	"rejected_milli" bigint DEFAULT 0 NOT NULL,
	"returned_milli" bigint DEFAULT 0 NOT NULL,
	"reason_code" text,
	"confirmation" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acceptance_version" UNIQUE("trip_cargo_id","version_no")
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"type" text NOT NULL,
	"trip_id" uuid,
	"order_id" uuid,
	"trip_cargo_id" uuid,
	"title" text NOT NULL,
	"responsible_user_id" uuid,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "acceptance" ADD CONSTRAINT "acceptance_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acceptance" ADD CONSTRAINT "acceptance_trip_cargo_id_trip_cargo_id_fk" FOREIGN KEY ("trip_cargo_id") REFERENCES "public"."trip_cargo"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acceptance" ADD CONSTRAINT "acceptance_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_trip_id_trip_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trip"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_order_id_sales_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_trip_cargo_id_trip_cargo_id_fk" FOREIGN KEY ("trip_cargo_id") REFERENCES "public"."trip_cargo"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_responsible_user_id_app_user_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "acceptance_current" ON "acceptance" USING btree ("trip_cargo_id") WHERE "acceptance"."is_current";--> statement-breakpoint
CREATE INDEX "task_status_idx" ON "task" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "task_trip_idx" ON "task" USING btree ("trip_id");