/** Build-time trust anchor. No runtime environment override and never a signing key.
 * Release configuration must replace these nulls with the operator's public SPKI and HTTPS activation URL.
 * Leaving it unconfigured deliberately fails closed; test keys live only in isolated fixture copies.
 */
"use strict";
module.exports = Object.freeze({ publicKey: null, activationURL: null });
