-- KVRN 042: QA registry for optional Marketing Suite and Store Credit source surfaces.
-- NOT APPLIED. Safe additive only. Review and apply to staging first.
-- No campaign send/credit issuance/API enablement or customer data operations.
BEGIN;
INSERT INTO qa_features(id,name,area,criticality,production_safe) VALUES
 ('marketing_suite','SMS and Email Marketing Suite','Marketing','high',FALSE),
 ('store_credit','Store credit liability/accounting','Finance','critical',FALSE)
ON CONFLICT(id) DO NOTHING;
INSERT INTO qa_test_cases(id,feature_id,name,test_type,command_key,production_safe) VALUES
 ('marketing_drafts_jest','marketing_suite','Marketing campaign draft/state constraints','unit','jest:marketing-campaign-drafts',TRUE),
 ('marketing_budget_jest','marketing_suite','SMS/email spend preflight fail closed','security','jest:marketing-dispatch-policy',TRUE),
 ('sms_optin_jest','marketing_suite','Verified double opt-in / suppression','security','jest:sms-double-optin',TRUE),
 ('store_credit_domain_jest','store_credit','Store credit liability state-machine','security','jest:store-credit-domain',TRUE),
 ('store_credit_identity_jest','store_credit','Secret-key derivation and identity safety','security','jest:store-credit-identity',TRUE)
ON CONFLICT(id) DO NOTHING;
COMMIT;
