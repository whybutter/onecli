/**
 * The edition's policy validator: provider-shape validation of session
 * policies (`github-app` repositories, `dropbox` folders). The plan gate the
 * cloud edition put in front of it is dropped, which leaves exactly the free
 * onprem validator — so that IS the export.
 */
export { onpremPolicyValidator as eePolicyValidator } from "../../services/policy-onprem-validator";
