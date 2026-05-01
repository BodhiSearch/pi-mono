/**
 * Per-session feature toggle store interface.
 *
 * Features are plain `boolean` flags keyed by string. Defaults live in
 * `FEATURE_DEFAULTS`; on every `get()` we merge the persisted flags on
 * top of the defaults so newly-introduced features show up without a
 * migration. `set()` only writes the override so the default surface
 * remains observable via deletion later if needed.
 *
 * The agent package ships only the interface; the host runtime
 * provides a concrete impl (the browser uses Dexie alongside the
 * `SessionStore` IDB).
 */

export interface FeatureDefaults {
	bashEnabled: boolean;
	forceToolCall: boolean;
}

export const FEATURE_DEFAULTS: FeatureDefaults = {
	bashEnabled: true,
	forceToolCall: false,
};

export type FeatureKey = keyof FeatureDefaults;

export function isFeatureKey(key: string): key is FeatureKey {
	return key in FEATURE_DEFAULTS;
}

export interface FeatureSnapshot extends FeatureDefaults {
	[key: string]: boolean;
}

export interface FeatureStore {
	get(sessionId: string): Promise<FeatureSnapshot>;
	set(sessionId: string, key: string, value: boolean): Promise<FeatureSnapshot>;
	clear(sessionId: string): Promise<void>;
}
