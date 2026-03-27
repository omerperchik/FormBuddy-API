// ============================================================
// Field Types — mirrors the Chrome extension's FieldType enum
// ============================================================
export const FIELD_TYPES = [
  'honorificPrefix', 'givenName', 'additionalName', 'familyName',
  'honorificSuffix', 'nickname', 'fullName',
  'email', 'emailWork', 'phone', 'phoneWork', 'phoneMobile',
  'streetAddress', 'addressLine2', 'city', 'state', 'postalCode', 'country', 'countryName',
  'workStreetAddress', 'workCity', 'workState', 'workPostalCode', 'workCountry',
  'organization', 'organizationTitle', 'department',
  'birthDate', 'birthDay', 'birthMonth', 'birthYear', 'sex',
  'url', 'username', 'password',
  'nationalId', 'passportNumber', 'driverLicense',
  'signature',
] as const;

export type FieldType = typeof FIELD_TYPES[number];

// Fields that are E2E encrypted at rest
export const SENSITIVE_FIELDS: Set<string> = new Set([
  'nationalId', 'passportNumber', 'driverLicense', 'password', 'signature',
]);

// ============================================================
// API Types
// ============================================================
export interface User {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  tier: 'free' | 'pro' | 'team';
  created_at: string;
}

export interface Profile {
  id: string;
  user_id: string;
  name: string;
  type: 'personal' | 'work' | 'family' | 'custom';
  icon: string;
  is_default: boolean;
  fields: Record<string, string>;
  custom_fields: CustomField[];
  created_at: string;
  updated_at: string;
}

export interface CustomField {
  id: string;
  label: string;
  value: string;
  sort_order: number;
}

export interface ProfileField {
  field_key: string;
  value: string;
  is_sensitive: boolean;
  vector_clock: number;
  updated_at: string;
}

export interface FormTemplate {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  country: string | null;
  language: string;
  field_mappings: FieldMapping[];
  is_public: boolean;
  use_count: number;
}

export interface FieldMapping {
  fieldKey: string;
  label: string;
  autocomplete?: string;
  required?: boolean;
}

export interface FillHistoryEntry {
  id: string;
  profile_id: string | null;
  template_id: string | null;
  form_url: string | null;
  form_title: string | null;
  fields_filled: number;
  source_platform: string;
  filled_at: string;
}

export interface SyncPayload {
  device_id: string;
  platform: 'chrome' | 'android' | 'ios';
  changes: SyncChange[];
  last_synced: string | null;
}

export interface SyncChange {
  profile_id: string;
  field_key: string;
  value: string;
  is_sensitive: boolean;
  vector_clock: number;
  updated_at: string;
  action: 'upsert' | 'delete';
}

export interface ClassifyRequest {
  fields: FormFieldInput[];
  form_url?: string;
}

export interface FormFieldInput {
  name: string;
  label?: string;
  type?: string;
  placeholder?: string;
  autocomplete?: string;
}

export interface ClassifyResult {
  name: string;
  classified_type: FieldType | null;
  confidence: number;
}

// JWT payload
export interface JWTPayload {
  sub: string;       // user id
  email: string;
  tier: string;
}
