/**
 * Single barrel for every ACP extension method constant used by the
 * web-acp surface. Keeping them centralised here means the adapter,
 * the client wrapper, and the React hooks all reach for the same
 * identifier — no string literals scattered across call sites.
 *
 * M0/M1 methods still use the pre-spec `bodhi/*` prefix; M2 onward
 * uses the spec-blessed `_bodhi/*` prefix. The rename of the older
 * constants is tracked as a deferred cleanup item so we don't churn
 * the M1 e2e contract mid-M2.
 */

export type {
	BodhiFeatureBag,
	BodhiFeaturesListResponse,
	BodhiFeaturesSetRequest,
	BodhiFeaturesSetResponse,
	BodhiVolumeDescriptor,
	BodhiVolumesListResponse,
} from "./index";
export {
	BODHI_AUTH_METHOD_ID,
	BODHI_FEATURES_LIST_METHOD,
	BODHI_FEATURES_SET_METHOD,
	BODHI_GET_SESSION_METHOD,
	BODHI_LIST_MODELS_METHOD,
	BODHI_LIST_SESSIONS_METHOD,
	BODHI_VOLUMES_LIST_METHOD,
} from "./index";
