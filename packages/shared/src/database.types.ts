export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      allocations: {
        Row: {
          count: number;
          created_at: string;
          group_id: string;
          id: string;
          is_keep: boolean;
          item_id: string;
          note: string | null;
          origin: Database["public"]["Enums"]["alloc_origin"];
          pinned: boolean;
          requested_item_id: string;
          source_room_id: string;
          updated_at: string;
          year_id: string;
        };
        ComputedFields: never;
        Insert: {
          count: number;
          created_at?: string;
          group_id: string;
          id?: string;
          is_keep?: boolean;
          item_id: string;
          note?: string | null;
          origin: Database["public"]["Enums"]["alloc_origin"];
          pinned?: boolean;
          requested_item_id: string;
          source_room_id: string;
          updated_at?: string;
          year_id: string;
        };
        Update: {
          count?: number;
          created_at?: string;
          group_id?: string;
          id?: string;
          is_keep?: boolean;
          item_id?: string;
          note?: string | null;
          origin?: Database["public"]["Enums"]["alloc_origin"];
          pinned?: boolean;
          requested_item_id?: string;
          source_room_id?: string;
          updated_at?: string;
          year_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "allocations_group_id_year_id_fkey";
            columns: ["group_id", "year_id"];
            isOneToOne: false;
            referencedRelation: "groups";
            referencedColumns: ["id", "year_id"];
          },
          {
            foreignKeyName: "allocations_item_id_fkey";
            columns: ["item_id"];
            isOneToOne: false;
            referencedRelation: "items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "allocations_requested_item_id_fkey";
            columns: ["requested_item_id"];
            isOneToOne: false;
            referencedRelation: "items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "allocations_source_room_id_fkey";
            columns: ["source_room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "allocations_year_id_fkey";
            columns: ["year_id"];
            isOneToOne: false;
            referencedRelation: "years";
            referencedColumns: ["id"];
          },
        ];
      };
      audit_logs: {
        Row: {
          action: string;
          after: Json | null;
          at: string;
          before: Json | null;
          group_id: string | null;
          id: number;
          reason: string | null;
          row_pk: NonNullable<Json>;
          table_name: string;
          user_id: string | null;
          year_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          action: string;
          after?: Json | null;
          at?: string;
          before?: Json | null;
          group_id?: string | null;
          id?: never;
          reason?: string | null;
          row_pk: NonNullable<Json>;
          table_name: string;
          user_id?: string | null;
          year_id?: string | null;
        };
        Update: {
          action?: string;
          after?: Json | null;
          at?: string;
          before?: Json | null;
          group_id?: string | null;
          id?: never;
          reason?: string | null;
          row_pk?: NonNullable<Json>;
          table_name?: string;
          user_id?: string | null;
          year_id?: string | null;
        };
        Relationships: [];
      };
      deliveries: {
        Row: {
          checked_at: string | null;
          checked_by: string | null;
          created_at: string;
          group_id: string;
          id: string;
          kind: Database["public"]["Enums"]["delivery_kind"];
          problem_note: string | null;
          returned: boolean;
          slot_id: string | null;
          status: Database["public"]["Enums"]["delivery_status"];
          team: number | null;
          updated_at: string;
          year_id: string;
        };
        ComputedFields: never;
        Insert: {
          checked_at?: string | null;
          checked_by?: string | null;
          created_at?: string;
          group_id: string;
          id?: string;
          kind: Database["public"]["Enums"]["delivery_kind"];
          problem_note?: string | null;
          returned?: boolean;
          slot_id?: string | null;
          status?: Database["public"]["Enums"]["delivery_status"];
          team?: number | null;
          updated_at?: string;
          year_id: string;
        };
        Update: {
          checked_at?: string | null;
          checked_by?: string | null;
          created_at?: string;
          group_id?: string;
          id?: string;
          kind?: Database["public"]["Enums"]["delivery_kind"];
          problem_note?: string | null;
          returned?: boolean;
          slot_id?: string | null;
          status?: Database["public"]["Enums"]["delivery_status"];
          team?: number | null;
          updated_at?: string;
          year_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "deliveries_group_id_year_id_fkey";
            columns: ["group_id", "year_id"];
            isOneToOne: false;
            referencedRelation: "groups";
            referencedColumns: ["id", "year_id"];
          },
          {
            foreignKeyName: "deliveries_slot_id_year_id_fkey";
            columns: ["slot_id", "year_id"];
            isOneToOne: false;
            referencedRelation: "slots";
            referencedColumns: ["id", "year_id"];
          },
          {
            foreignKeyName: "deliveries_year_id_fkey";
            columns: ["year_id"];
            isOneToOne: false;
            referencedRelation: "years";
            referencedColumns: ["id"];
          },
        ];
      };
      distance_overrides: {
        Row: {
          building_a: string;
          building_b: string;
          cost: number;
          created_at: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          building_a: string;
          building_b: string;
          cost: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          building_a?: string;
          building_b?: string;
          cost?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      document_files: {
        Row: {
          content_type: string;
          created_at: string;
          created_by: string | null;
          document_id: string;
          group_id: string;
          id: string;
          object_path: string;
          size: number;
          updated_at: string;
          year_id: string;
        };
        ComputedFields: never;
        Insert: {
          content_type: string;
          created_at?: string;
          created_by?: string | null;
          document_id: string;
          group_id: string;
          id: string;
          object_path: string;
          size: number;
          updated_at?: string;
          year_id: string;
        };
        Update: {
          content_type?: string;
          created_at?: string;
          created_by?: string | null;
          document_id?: string;
          group_id?: string;
          id?: string;
          object_path?: string;
          size?: number;
          updated_at?: string;
          year_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "document_files_submission_fkey";
            columns: ["document_id", "group_id", "year_id"];
            isOneToOne: false;
            referencedRelation: "document_submissions";
            referencedColumns: ["document_id", "group_id", "year_id"];
          },
        ];
      };
      document_submissions: {
        Row: {
          created_at: string;
          document_id: string;
          group_id: string;
          proxy: boolean;
          review_note: string | null;
          reviewed_at: string | null;
          reviewed_by: string | null;
          status: Database["public"]["Enums"]["document_status"];
          submitted_at: string | null;
          submitted_by: string | null;
          updated_at: string;
          year_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          document_id: string;
          group_id: string;
          proxy?: boolean;
          review_note?: string | null;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          status?: Database["public"]["Enums"]["document_status"];
          submitted_at?: string | null;
          submitted_by?: string | null;
          updated_at?: string;
          year_id: string;
        };
        Update: {
          created_at?: string;
          document_id?: string;
          group_id?: string;
          proxy?: boolean;
          review_note?: string | null;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          status?: Database["public"]["Enums"]["document_status"];
          submitted_at?: string | null;
          submitted_by?: string | null;
          updated_at?: string;
          year_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "document_submissions_document_fkey";
            columns: ["document_id", "year_id"];
            isOneToOne: false;
            referencedRelation: "documents";
            referencedColumns: ["id", "year_id"];
          },
          {
            foreignKeyName: "document_submissions_document_fkey";
            columns: ["document_id", "year_id"];
            isOneToOne: false;
            referencedRelation: "v_document_status";
            referencedColumns: ["document_id", "year_id"];
          },
          {
            foreignKeyName: "document_submissions_group_fkey";
            columns: ["group_id", "year_id"];
            isOneToOne: false;
            referencedRelation: "groups";
            referencedColumns: ["id", "year_id"];
          },
        ];
      };
      documents: {
        Row: {
          created_at: string;
          created_by: string | null;
          deadline: string;
          description: string | null;
          files_deleted_at: string | null;
          food_only: boolean;
          id: string;
          requires_file: boolean;
          target_categories: Database["public"]["Enums"]["group_category"][];
          title: string;
          updated_at: string;
          updated_by: string | null;
          year_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          deadline: string;
          description?: string | null;
          files_deleted_at?: string | null;
          food_only?: boolean;
          id?: string;
          requires_file?: boolean;
          target_categories: Database["public"]["Enums"]["group_category"][];
          title: string;
          updated_at?: string;
          updated_by?: string | null;
          year_id: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          deadline?: string;
          description?: string | null;
          files_deleted_at?: string | null;
          food_only?: boolean;
          id?: string;
          requires_file?: boolean;
          target_categories?: Database["public"]["Enums"]["group_category"][];
          title?: string;
          updated_at?: string;
          updated_by?: string | null;
          year_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "documents_year_id_fkey";
            columns: ["year_id"];
            isOneToOne: false;
            referencedRelation: "years";
            referencedColumns: ["id"];
          },
        ];
      };
      events: {
        Row: {
          all_day: boolean;
          audience: Database["public"]["Enums"]["event_audience"];
          created_at: string;
          created_by: string | null;
          ends_at: string | null;
          id: string;
          kind: Database["public"]["Enums"]["event_kind"];
          note: string | null;
          starts_at: string;
          title: string;
          updated_at: string;
          updated_by: string | null;
          year_id: string;
        };
        ComputedFields: never;
        Insert: {
          all_day?: boolean;
          audience: Database["public"]["Enums"]["event_audience"];
          created_at?: string;
          created_by?: string | null;
          ends_at?: string | null;
          id?: string;
          kind: Database["public"]["Enums"]["event_kind"];
          note?: string | null;
          starts_at: string;
          title: string;
          updated_at?: string;
          updated_by?: string | null;
          year_id: string;
        };
        Update: {
          all_day?: boolean;
          audience?: Database["public"]["Enums"]["event_audience"];
          created_at?: string;
          created_by?: string | null;
          ends_at?: string | null;
          id?: string;
          kind?: Database["public"]["Enums"]["event_kind"];
          note?: string | null;
          starts_at?: string;
          title?: string;
          updated_at?: string;
          updated_by?: string | null;
          year_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "events_year_id_fkey";
            columns: ["year_id"];
            isOneToOne: false;
            referencedRelation: "years";
            referencedColumns: ["id"];
          },
        ];
      };
      group_members: {
        Row: {
          created_at: string;
          group_id: string;
          role: Database["public"]["Enums"]["group_role"];
          updated_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          group_id: string;
          role?: Database["public"]["Enums"]["group_role"];
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          group_id?: string;
          role?: Database["public"]["Enums"]["group_role"];
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "group_members_group_id_fkey";
            columns: ["group_id"];
            isOneToOne: false;
            referencedRelation: "groups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "group_members_group_id_fkey";
            columns: ["group_id"];
            isOneToOne: false;
            referencedRelation: "v_document_status";
            referencedColumns: ["group_id"];
          },
        ];
      };
      groups: {
        Row: {
          aliases: string[];
          category: Database["public"]["Enums"]["group_category"];
          created_at: string;
          display_name: string | null;
          id: string;
          is_food: boolean;
          location_room_id: string | null;
          name: string;
          sort_order: number;
          updated_at: string;
          year_id: string;
        };
        ComputedFields: never;
        Insert: {
          aliases?: string[];
          category: Database["public"]["Enums"]["group_category"];
          created_at?: string;
          display_name?: string | null;
          id?: string;
          is_food?: boolean;
          location_room_id?: string | null;
          name: string;
          sort_order?: number;
          updated_at?: string;
          year_id: string;
        };
        Update: {
          aliases?: string[];
          category?: Database["public"]["Enums"]["group_category"];
          created_at?: string;
          display_name?: string | null;
          id?: string;
          is_food?: boolean;
          location_room_id?: string | null;
          name?: string;
          sort_order?: number;
          updated_at?: string;
          year_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "groups_location_room_id_fkey";
            columns: ["location_room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "groups_year_id_fkey";
            columns: ["year_id"];
            isOneToOne: false;
            referencedRelation: "years";
            referencedColumns: ["id"];
          },
        ];
      };
      invitations: {
        Row: {
          created_at: string;
          email: string;
          group_id: string | null;
          group_role: Database["public"]["Enums"]["group_role"] | null;
          id: string;
          role: Database["public"]["Enums"]["app_role"] | null;
          updated_at: string;
          used_at: string | null;
          year_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          email: string;
          group_id?: string | null;
          group_role?: Database["public"]["Enums"]["group_role"] | null;
          id?: string;
          role?: Database["public"]["Enums"]["app_role"] | null;
          updated_at?: string;
          used_at?: string | null;
          year_id: string;
        };
        Update: {
          created_at?: string;
          email?: string;
          group_id?: string | null;
          group_role?: Database["public"]["Enums"]["group_role"] | null;
          id?: string;
          role?: Database["public"]["Enums"]["app_role"] | null;
          updated_at?: string;
          used_at?: string | null;
          year_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "invitations_group_id_year_id_fkey";
            columns: ["group_id", "year_id"];
            isOneToOne: false;
            referencedRelation: "groups";
            referencedColumns: ["id", "year_id"];
          },
          {
            foreignKeyName: "invitations_year_id_fkey";
            columns: ["year_id"];
            isOneToOne: false;
            referencedRelation: "years";
            referencedColumns: ["id"];
          },
        ];
      };
      items: {
        Row: {
          aliases: string[];
          code: string;
          created_at: string;
          id: string;
          name: string;
          requestable_categories: Database["public"]["Enums"]["group_category"][];
          sort_order: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          aliases?: string[];
          code: string;
          created_at?: string;
          id?: string;
          name: string;
          requestable_categories?: Database["public"]["Enums"]["group_category"][];
          sort_order: number;
          updated_at?: string;
        };
        Update: {
          aliases?: string[];
          code?: string;
          created_at?: string;
          id?: string;
          name?: string;
          requestable_categories?: Database["public"]["Enums"]["group_category"][];
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      notice_groups: {
        Row: {
          created_at: string;
          group_id: string;
          notice_id: string;
          updated_at: string;
          year_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          group_id: string;
          notice_id: string;
          updated_at?: string;
          year_id: string;
        };
        Update: {
          created_at?: string;
          group_id?: string;
          notice_id?: string;
          updated_at?: string;
          year_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notice_groups_group_fkey";
            columns: ["group_id", "year_id"];
            isOneToOne: false;
            referencedRelation: "groups";
            referencedColumns: ["id", "year_id"];
          },
          {
            foreignKeyName: "notice_groups_notice_fkey";
            columns: ["notice_id", "year_id"];
            isOneToOne: false;
            referencedRelation: "notices";
            referencedColumns: ["id", "year_id"];
          },
        ];
      };
      notices: {
        Row: {
          audience: Database["public"]["Enums"]["notice_audience"];
          body: string | null;
          created_at: string;
          created_by: string | null;
          id: string;
          pinned: boolean;
          title: string;
          updated_at: string;
          updated_by: string | null;
          year_id: string;
        };
        ComputedFields: never;
        Insert: {
          audience: Database["public"]["Enums"]["notice_audience"];
          body?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          pinned?: boolean;
          title: string;
          updated_at?: string;
          updated_by?: string | null;
          year_id: string;
        };
        Update: {
          audience?: Database["public"]["Enums"]["notice_audience"];
          body?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          pinned?: boolean;
          title?: string;
          updated_at?: string;
          updated_by?: string | null;
          year_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notices_year_id_fkey";
            columns: ["year_id"];
            isOneToOne: false;
            referencedRelation: "years";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          created_at: string;
          display_name: string;
          updated_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          display_name: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          display_name?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      request_submissions: {
        Row: {
          created_at: string;
          group_id: string;
          note: string | null;
          submitted_at: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          group_id: string;
          note?: string | null;
          submitted_at?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          created_at?: string;
          group_id?: string;
          note?: string | null;
          submitted_at?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "request_submissions_group_id_fkey";
            columns: ["group_id"];
            isOneToOne: true;
            referencedRelation: "groups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "request_submissions_group_id_fkey";
            columns: ["group_id"];
            isOneToOne: true;
            referencedRelation: "v_document_status";
            referencedColumns: ["group_id"];
          },
        ];
      };
      requests: {
        Row: {
          count: number;
          created_at: string;
          group_id: string;
          item_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          count: number;
          created_at?: string;
          group_id: string;
          item_id: string;
          updated_at?: string;
        };
        Update: {
          count?: number;
          created_at?: string;
          group_id?: string;
          item_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "requests_group_id_fkey";
            columns: ["group_id"];
            isOneToOne: false;
            referencedRelation: "groups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "requests_group_id_fkey";
            columns: ["group_id"];
            isOneToOne: false;
            referencedRelation: "v_document_status";
            referencedColumns: ["group_id"];
          },
          {
            foreignKeyName: "requests_item_id_fkey";
            columns: ["item_id"];
            isOneToOne: false;
            referencedRelation: "items";
            referencedColumns: ["id"];
          },
        ];
      };
      room_years: {
        Row: {
          created_at: string;
          note: string | null;
          room_id: string;
          updated_at: string;
          usable: boolean;
          year_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          note?: string | null;
          room_id: string;
          updated_at?: string;
          usable?: boolean;
          year_id: string;
        };
        Update: {
          created_at?: string;
          note?: string | null;
          room_id?: string;
          updated_at?: string;
          usable?: boolean;
          year_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "room_years_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "room_years_year_id_fkey";
            columns: ["year_id"];
            isOneToOne: false;
            referencedRelation: "years";
            referencedColumns: ["id"];
          },
        ];
      };
      rooms: {
        Row: {
          aliases: string[];
          building: string | null;
          created_at: string;
          extra_cost: number;
          floor: number | null;
          id: string;
          is_storage: boolean;
          kind: Database["public"]["Enums"]["room_kind"];
          name: string;
          sort_order: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          aliases?: string[];
          building?: string | null;
          created_at?: string;
          extra_cost?: number;
          floor?: number | null;
          id?: string;
          is_storage?: boolean;
          kind?: Database["public"]["Enums"]["room_kind"];
          name: string;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          aliases?: string[];
          building?: string | null;
          created_at?: string;
          extra_cost?: number;
          floor?: number | null;
          id?: string;
          is_storage?: boolean;
          kind?: Database["public"]["Enums"]["room_kind"];
          name?: string;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      rules: {
        Row: {
          code: string;
          created_at: string;
          enabled: boolean;
          id: string;
          kind: Database["public"]["Enums"]["rule_kind"];
          memo: string | null;
          params: NonNullable<Json>;
          updated_at: string;
          year_id: string;
        };
        ComputedFields: never;
        Insert: {
          code: string;
          created_at?: string;
          enabled?: boolean;
          id?: string;
          kind: Database["public"]["Enums"]["rule_kind"];
          memo?: string | null;
          params: NonNullable<Json>;
          updated_at?: string;
          year_id: string;
        };
        Update: {
          code?: string;
          created_at?: string;
          enabled?: boolean;
          id?: string;
          kind?: Database["public"]["Enums"]["rule_kind"];
          memo?: string | null;
          params?: NonNullable<Json>;
          updated_at?: string;
          year_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "rules_year_id_fkey";
            columns: ["year_id"];
            isOneToOne: false;
            referencedRelation: "years";
            referencedColumns: ["id"];
          },
        ];
      };
      shift_assignments: {
        Row: {
          created_at: string;
          duty_id: string;
          slot_id: string;
          updated_at: string;
          user_id: string;
          year_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          duty_id: string;
          slot_id: string;
          updated_at?: string;
          user_id: string;
          year_id: string;
        };
        Update: {
          created_at?: string;
          duty_id?: string;
          slot_id?: string;
          updated_at?: string;
          user_id?: string;
          year_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "shift_assignments_member_fkey";
            columns: ["year_id", "user_id"];
            isOneToOne: false;
            referencedRelation: "year_roles";
            referencedColumns: ["year_id", "user_id"];
          },
          {
            foreignKeyName: "shift_assignments_need_fkey";
            columns: ["slot_id", "duty_id", "year_id"];
            isOneToOne: false;
            referencedRelation: "shift_needs";
            referencedColumns: ["slot_id", "duty_id", "year_id"];
          },
          {
            foreignKeyName: "shift_assignments_year_id_fkey";
            columns: ["year_id"];
            isOneToOne: false;
            referencedRelation: "years";
            referencedColumns: ["id"];
          },
        ];
      };
      shift_duties: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          note: string | null;
          place: string | null;
          sort_order: number;
          updated_at: string;
          year_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          note?: string | null;
          place?: string | null;
          sort_order?: number;
          updated_at?: string;
          year_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          note?: string | null;
          place?: string | null;
          sort_order?: number;
          updated_at?: string;
          year_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "shift_duties_year_id_fkey";
            columns: ["year_id"];
            isOneToOne: false;
            referencedRelation: "years";
            referencedColumns: ["id"];
          },
        ];
      };
      shift_needs: {
        Row: {
          created_at: string;
          duty_id: string;
          required_count: number;
          slot_id: string;
          updated_at: string;
          year_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          duty_id: string;
          required_count?: number;
          slot_id: string;
          updated_at?: string;
          year_id: string;
        };
        Update: {
          created_at?: string;
          duty_id?: string;
          required_count?: number;
          slot_id?: string;
          updated_at?: string;
          year_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "shift_needs_duty_fkey";
            columns: ["duty_id", "year_id"];
            isOneToOne: false;
            referencedRelation: "shift_duties";
            referencedColumns: ["id", "year_id"];
          },
          {
            foreignKeyName: "shift_needs_slot_fkey";
            columns: ["slot_id", "year_id"];
            isOneToOne: false;
            referencedRelation: "shift_slots";
            referencedColumns: ["id", "year_id"];
          },
          {
            foreignKeyName: "shift_needs_year_id_fkey";
            columns: ["year_id"];
            isOneToOne: false;
            referencedRelation: "years";
            referencedColumns: ["id"];
          },
        ];
      };
      shift_slots: {
        Row: {
          created_at: string;
          ends_at: string;
          id: string;
          starts_at: string;
          updated_at: string;
          year_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          ends_at: string;
          id?: string;
          starts_at: string;
          updated_at?: string;
          year_id: string;
        };
        Update: {
          created_at?: string;
          ends_at?: string;
          id?: string;
          starts_at?: string;
          updated_at?: string;
          year_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "shift_slots_year_id_fkey";
            columns: ["year_id"];
            isOneToOne: false;
            referencedRelation: "years";
            referencedColumns: ["id"];
          },
        ];
      };
      slots: {
        Row: {
          created_at: string;
          day: Database["public"]["Enums"]["festival_day"];
          ends_at: string | null;
          id: string;
          label: string;
          starts_at: string | null;
          updated_at: string;
          year_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          day: Database["public"]["Enums"]["festival_day"];
          ends_at?: string | null;
          id?: string;
          label: string;
          starts_at?: string | null;
          updated_at?: string;
          year_id: string;
        };
        Update: {
          created_at?: string;
          day?: Database["public"]["Enums"]["festival_day"];
          ends_at?: string | null;
          id?: string;
          label?: string;
          starts_at?: string | null;
          updated_at?: string;
          year_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "slots_year_id_fkey";
            columns: ["year_id"];
            isOneToOne: false;
            referencedRelation: "years";
            referencedColumns: ["id"];
          },
        ];
      };
      stocks: {
        Row: {
          count: number;
          counted_at: string | null;
          counted_by: string | null;
          created_at: string;
          item_id: string;
          room_id: string;
          updated_at: string;
          year_id: string;
        };
        ComputedFields: never;
        Insert: {
          count: number;
          counted_at?: string | null;
          counted_by?: string | null;
          created_at?: string;
          item_id: string;
          room_id: string;
          updated_at?: string;
          year_id: string;
        };
        Update: {
          count?: number;
          counted_at?: string | null;
          counted_by?: string | null;
          created_at?: string;
          item_id?: string;
          room_id?: string;
          updated_at?: string;
          year_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "stocks_item_id_fkey";
            columns: ["item_id"];
            isOneToOne: false;
            referencedRelation: "items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "stocks_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "stocks_year_id_fkey";
            columns: ["year_id"];
            isOneToOne: false;
            referencedRelation: "years";
            referencedColumns: ["id"];
          },
        ];
      };
      substitution_consents: {
        Row: {
          count: number | null;
          created_at: string;
          from_item_id: string;
          group_id: string;
          note: string | null;
          status: Database["public"]["Enums"]["consent_status"];
          to_item_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          count?: number | null;
          created_at?: string;
          from_item_id: string;
          group_id: string;
          note?: string | null;
          status?: Database["public"]["Enums"]["consent_status"];
          to_item_id: string;
          updated_at?: string;
        };
        Update: {
          count?: number | null;
          created_at?: string;
          from_item_id?: string;
          group_id?: string;
          note?: string | null;
          status?: Database["public"]["Enums"]["consent_status"];
          to_item_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "substitution_consents_from_item_id_fkey";
            columns: ["from_item_id"];
            isOneToOne: false;
            referencedRelation: "items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "substitution_consents_group_id_fkey";
            columns: ["group_id"];
            isOneToOne: false;
            referencedRelation: "groups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "substitution_consents_group_id_fkey";
            columns: ["group_id"];
            isOneToOne: false;
            referencedRelation: "v_document_status";
            referencedColumns: ["group_id"];
          },
          {
            foreignKeyName: "substitution_consents_to_item_id_fkey";
            columns: ["to_item_id"];
            isOneToOne: false;
            referencedRelation: "items";
            referencedColumns: ["id"];
          },
        ];
      };
      tasks: {
        Row: {
          assignee_id: string | null;
          created_at: string;
          created_by: string | null;
          due_at: string | null;
          id: string;
          note: string | null;
          status: Database["public"]["Enums"]["task_status"];
          title: string;
          updated_at: string;
          updated_by: string | null;
          year_id: string;
        };
        ComputedFields: never;
        Insert: {
          assignee_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          due_at?: string | null;
          id?: string;
          note?: string | null;
          status?: Database["public"]["Enums"]["task_status"];
          title: string;
          updated_at?: string;
          updated_by?: string | null;
          year_id: string;
        };
        Update: {
          assignee_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          due_at?: string | null;
          id?: string;
          note?: string | null;
          status?: Database["public"]["Enums"]["task_status"];
          title?: string;
          updated_at?: string;
          updated_by?: string | null;
          year_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tasks_assignee_fkey";
            columns: ["year_id", "assignee_id"];
            isOneToOne: false;
            referencedRelation: "year_roles";
            referencedColumns: ["year_id", "user_id"];
          },
          {
            foreignKeyName: "tasks_year_id_fkey";
            columns: ["year_id"];
            isOneToOne: false;
            referencedRelation: "years";
            referencedColumns: ["id"];
          },
        ];
      };
      year_roles: {
        Row: {
          created_at: string;
          role: Database["public"]["Enums"]["app_role"];
          updated_at: string;
          user_id: string;
          year_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          role: Database["public"]["Enums"]["app_role"];
          updated_at?: string;
          user_id: string;
          year_id: string;
        };
        Update: {
          created_at?: string;
          role?: Database["public"]["Enums"]["app_role"];
          updated_at?: string;
          user_id?: string;
          year_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "year_roles_year_id_fkey";
            columns: ["year_id"];
            isOneToOne: false;
            referencedRelation: "years";
            referencedColumns: ["id"];
          },
        ];
      };
      years: {
        Row: {
          allocation_version: number;
          auto_allocated_at: string | null;
          created_at: string;
          festival_start: string;
          id: string;
          label: string;
          prev_year_id: string | null;
          request_close_at: string | null;
          request_open_at: string | null;
          status: Database["public"]["Enums"]["year_status"];
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          allocation_version?: number;
          auto_allocated_at?: string | null;
          created_at?: string;
          festival_start: string;
          id?: string;
          label: string;
          prev_year_id?: string | null;
          request_close_at?: string | null;
          request_open_at?: string | null;
          status?: Database["public"]["Enums"]["year_status"];
          updated_at?: string;
        };
        Update: {
          allocation_version?: number;
          auto_allocated_at?: string | null;
          created_at?: string;
          festival_start?: string;
          id?: string;
          label?: string;
          prev_year_id?: string | null;
          request_close_at?: string | null;
          request_open_at?: string | null;
          status?: Database["public"]["Enums"]["year_status"];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "years_prev_year_id_fkey";
            columns: ["prev_year_id"];
            isOneToOne: false;
            referencedRelation: "years";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      v_document_files: {
        Row: {
          content_type: string;
          created_at: string;
          created_by: string | null;
          document_id: string;
          group_id: string;
          id: string;
          object_path: string;
          size: number;
          stored_size: number | null;
          uploaded: boolean | null;
          year_id: string;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "document_files_submission_fkey";
            columns: ["document_id", "group_id", "year_id"];
            isOneToOne: false;
            referencedRelation: "document_submissions";
            referencedColumns: ["document_id", "group_id", "year_id"];
          },
        ];
      };
      v_document_status: {
        Row: {
          deadline: string;
          description: string | null;
          document_id: string;
          group_id: string;
          late: boolean | null;
          proxy: boolean | null;
          requires_file: boolean;
          review_note: string | null;
          reviewed_at: string | null;
          reviewed_by: string | null;
          status: Database["public"]["Enums"]["document_status"] | null;
          submitted_at: string | null;
          submitted_by: string | null;
          title: string;
          updated_at: string | null;
          year_id: string;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "documents_year_id_fkey";
            columns: ["year_id"];
            isOneToOne: false;
            referencedRelation: "years";
            referencedColumns: ["id"];
          },
        ];
      };
      v_remaining: {
        Row: {
          allocated: number | null;
          item_id: string;
          remaining: number | null;
          room_id: string;
          stock: number;
          year_id: string;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "stocks_item_id_fkey";
            columns: ["item_id"];
            isOneToOne: false;
            referencedRelation: "items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "stocks_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "stocks_year_id_fkey";
            columns: ["year_id"];
            isOneToOne: false;
            referencedRelation: "years";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Functions: {
      accept_my_invitations: { Args: Record<PropertyKey, never>; Returns: number };
      add_shift_slots: {
        Args: { p_needs?: Json; p_slots: Json; p_year_id: string };
        Returns: {
          created_at: string;
          ends_at: string;
          id: string;
          starts_at: string;
          updated_at: string;
          year_id: string;
        }[];
        SetofOptions: {
          from: "*";
          to: "shift_slots";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      approve_document: {
        Args: {
          p_base_updated_at: string;
          p_document_id: string;
          p_group_id: string;
          p_note: string;
        };
        Returns: {
          created_at: string;
          document_id: string;
          group_id: string;
          proxy: boolean;
          review_note: string | null;
          reviewed_at: string | null;
          reviewed_by: string | null;
          status: Database["public"]["Enums"]["document_status"];
          submitted_at: string | null;
          submitted_by: string | null;
          updated_at: string;
          year_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "document_submissions";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      check_delivery: {
        Args: {
          p_delivery_id: string;
          p_problem_note?: string;
          p_returned?: boolean;
          p_status: Database["public"]["Enums"]["delivery_status"];
        };
        Returns: {
          checked_at: string | null;
          checked_by: string | null;
          created_at: string;
          group_id: string;
          id: string;
          kind: Database["public"]["Enums"]["delivery_kind"];
          problem_note: string | null;
          returned: boolean;
          slot_id: string | null;
          status: Database["public"]["Enums"]["delivery_status"];
          team: number | null;
          updated_at: string;
          year_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "deliveries";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      copy_previous_documents: {
        Args: { p_document_ids: string[]; p_year_id: string };
        Returns: {
          created_at: string;
          created_by: string | null;
          deadline: string;
          description: string | null;
          files_deleted_at: string | null;
          food_only: boolean;
          id: string;
          requires_file: boolean;
          target_categories: Database["public"]["Enums"]["group_category"][];
          title: string;
          updated_at: string;
          updated_by: string | null;
          year_id: string;
        }[];
        SetofOptions: {
          from: "*";
          to: "documents";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      create_year_from: {
        Args: { p_festival_start: string; p_label: string; p_prev_year_id: string };
        Returns: {
          allocation_version: number;
          auto_allocated_at: string | null;
          created_at: string;
          festival_start: string;
          id: string;
          label: string;
          prev_year_id: string | null;
          request_close_at: string | null;
          request_open_at: string | null;
          status: Database["public"]["Enums"]["year_status"];
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "years";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      delete_notice: {
        Args: { p_base_updated_at: string; p_notice_id: string };
        Returns: undefined;
      };
      delete_year_document_files: {
        Args: { p_reason?: string; p_year_id: string };
        Returns: number;
      };
      discard_document_file: { Args: { p_file_id: string }; Returns: string };
      document_orphan_paths: { Args: { p_year_id: string }; Returns: string[] };
      document_storage_usage: {
        Args: { p_year_id: string };
        Returns: {
          bucket_bytes: number;
          file_bytes: number;
          file_count: number;
          limit_bytes: number;
          orphan_count: number;
        }[];
      };
      invite: {
        Args: {
          p_email: string;
          p_group_id?: string;
          p_group_role?: Database["public"]["Enums"]["group_role"];
          p_role?: Database["public"]["Enums"]["app_role"];
          p_year_id: string;
        };
        Returns: Json;
      };
      previous_year_documents: {
        Args: { p_year_id: string };
        Returns: {
          deadline: string;
          description: string;
          document_id: string;
          exists_in_year: boolean;
          food_only: boolean;
          new_deadline: string;
          requires_file: boolean;
          target_categories: Database["public"]["Enums"]["group_category"][];
          title: string;
        }[];
      };
      previous_year_requests: {
        Args: { p_year_id: string };
        Returns: {
          count: number;
          group_name: string;
          item_id: string;
        }[];
      };
      previous_year_stocks: {
        Args: { p_year_id: string };
        Returns: {
          count: number;
          item_id: string;
          room_id: string;
        }[];
      };
      remove_group_member: {
        Args: { p_group_id: string; p_reason?: string; p_user_id: string };
        Returns: undefined;
      };
      remove_role: {
        Args: { p_reason?: string; p_user_id: string; p_year_id: string };
        Returns: undefined;
      };
      reserve_document_file: {
        Args: {
          p_content_type: string;
          p_document_id: string;
          p_file_id: string;
          p_group_id: string;
          p_size: number;
        };
        Returns: {
          content_type: string;
          created_at: string;
          created_by: string | null;
          document_id: string;
          group_id: string;
          id: string;
          object_path: string;
          size: number;
          updated_at: string;
          year_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "document_files";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      return_document: {
        Args: {
          p_base_updated_at: string;
          p_document_id: string;
          p_group_id: string;
          p_note: string;
        };
        Returns: {
          created_at: string;
          document_id: string;
          group_id: string;
          proxy: boolean;
          review_note: string | null;
          reviewed_at: string | null;
          reviewed_by: string | null;
          status: Database["public"]["Enums"]["document_status"];
          submitted_at: string | null;
          submitted_by: string | null;
          updated_at: string;
          year_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "document_submissions";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      revoke_invitation: { Args: { p_invitation_id: string }; Returns: undefined };
      save_allocation_rows: {
        Args: { p_changes: Json; p_reason: string; p_year_id: string };
        Returns: Json;
      };
      save_auto_allocations: {
        Args: { p_base_version: number; p_mode: string; p_rows: Json; p_year_id: string };
        Returns: Json;
      };
      save_notice: {
        Args: {
          p_audience: Database["public"]["Enums"]["notice_audience"];
          p_base_updated_at?: string;
          p_body?: string;
          p_group_ids?: string[];
          p_notice_id?: string;
          p_pinned?: boolean;
          p_title: string;
          p_year_id: string;
        };
        Returns: {
          audience: Database["public"]["Enums"]["notice_audience"];
          body: string | null;
          created_at: string;
          created_by: string | null;
          id: string;
          pinned: boolean;
          title: string;
          updated_at: string;
          updated_by: string | null;
          year_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "notices";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      set_consent: {
        Args: {
          p_from_item: string;
          p_group_id: string;
          p_note?: string;
          p_status: Database["public"]["Enums"]["consent_status"];
          p_to_item: string;
        };
        Returns: {
          count: number | null;
          created_at: string;
          from_item_id: string;
          group_id: string;
          note: string | null;
          status: Database["public"]["Enums"]["consent_status"];
          to_item_id: string;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "substitution_consents";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      set_group_member_role: {
        Args: {
          p_group_id: string;
          p_group_role: Database["public"]["Enums"]["group_role"];
          p_reason?: string;
          p_user_id: string;
        };
        Returns: undefined;
      };
      set_role: {
        Args: {
          p_reason?: string;
          p_role: Database["public"]["Enums"]["app_role"];
          p_user_id: string;
          p_year_id: string;
        };
        Returns: undefined;
      };
      set_task_status: {
        Args: {
          p_base_updated_at: string;
          p_status: Database["public"]["Enums"]["task_status"];
          p_task_id: string;
        };
        Returns: {
          assignee_id: string | null;
          created_at: string;
          created_by: string | null;
          due_at: string | null;
          id: string;
          note: string | null;
          status: Database["public"]["Enums"]["task_status"];
          title: string;
          updated_at: string;
          updated_by: string | null;
          year_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "tasks";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      set_year_status: {
        Args: {
          p_base_version?: number;
          p_reason?: string;
          p_to: Database["public"]["Enums"]["year_status"];
          p_year_id: string;
        };
        Returns: {
          allocation_version: number;
          auto_allocated_at: string | null;
          created_at: string;
          festival_start: string;
          id: string;
          label: string;
          prev_year_id: string | null;
          request_close_at: string | null;
          request_open_at: string | null;
          status: Database["public"]["Enums"]["year_status"];
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "years";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      submit_document: {
        Args: { p_base_updated_at: string; p_document_id: string; p_group_id: string };
        Returns: {
          created_at: string;
          document_id: string;
          group_id: string;
          proxy: boolean;
          review_note: string | null;
          reviewed_at: string | null;
          reviewed_by: string | null;
          status: Database["public"]["Enums"]["document_status"];
          submitted_at: string | null;
          submitted_by: string | null;
          updated_at: string;
          year_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "document_submissions";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      submit_requests: {
        Args: { p_group_id: string; p_note?: string; p_rows: Json };
        Returns: {
          created_at: string;
          group_id: string;
          note: string | null;
          submitted_at: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "request_submissions";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      update_requests_after_deadline: {
        Args: { p_group_id: string; p_reason: string; p_rows: Json; p_submission?: Json };
        Returns: undefined;
      };
      update_year: {
        Args: { p_patch: Json; p_reason?: string; p_year_id: string };
        Returns: {
          allocation_version: number;
          auto_allocated_at: string | null;
          created_at: string;
          festival_start: string;
          id: string;
          label: string;
          prev_year_id: string | null;
          request_close_at: string | null;
          request_open_at: string | null;
          status: Database["public"]["Enums"]["year_status"];
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "years";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      withdraw_document: {
        Args: { p_base_updated_at: string; p_document_id: string; p_group_id: string };
        Returns: {
          created_at: string;
          document_id: string;
          group_id: string;
          proxy: boolean;
          review_note: string | null;
          reviewed_at: string | null;
          reviewed_by: string | null;
          status: Database["public"]["Enums"]["document_status"];
          submitted_at: string | null;
          submitted_by: string | null;
          updated_at: string;
          year_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "document_submissions";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
    };
    Enums: {
      alloc_origin: "auto" | "manual";
      app_role: "admin" | "head" | "deputy_head" | "staff" | "viewer";
      consent_status: "not_asked" | "asked" | "accepted" | "declined";
      delivery_kind: "furniture" | "tent" | "weight" | "side_curtain";
      delivery_status: "pending" | "done" | "problem";
      document_status: "not_submitted" | "submitted" | "returned" | "approved";
      event_audience: "soumu" | "groups" | "all";
      event_kind: "deadline" | "event";
      festival_day: "day_minus2" | "day_minus1" | "day1" | "day2";
      group_category: "stall" | "department" | "company" | "rest_area";
      group_role: "manager" | "deputy_manager";
      notice_audience: "soumu" | "all_groups" | "groups";
      room_kind: "room" | "gym" | "outdoor" | "other";
      rule_kind: "substitute" | "source_restrict" | "fixed_request" | "keep";
      task_status: "todo" | "doing" | "done";
      year_status: "preparing" | "requesting" | "allocating" | "confirmed" | "closed";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      alloc_origin: ["auto", "manual"],
      app_role: ["admin", "head", "deputy_head", "staff", "viewer"],
      consent_status: ["not_asked", "asked", "accepted", "declined"],
      delivery_kind: ["furniture", "tent", "weight", "side_curtain"],
      delivery_status: ["pending", "done", "problem"],
      document_status: ["not_submitted", "submitted", "returned", "approved"],
      event_audience: ["soumu", "groups", "all"],
      event_kind: ["deadline", "event"],
      festival_day: ["day_minus2", "day_minus1", "day1", "day2"],
      group_category: ["stall", "department", "company", "rest_area"],
      group_role: ["manager", "deputy_manager"],
      notice_audience: ["soumu", "all_groups", "groups"],
      room_kind: ["room", "gym", "outdoor", "other"],
      rule_kind: ["substitute", "source_restrict", "fixed_request", "keep"],
      task_status: ["todo", "doing", "done"],
      year_status: ["preparing", "requesting", "allocating", "confirmed", "closed"],
    },
  },
} as const;
