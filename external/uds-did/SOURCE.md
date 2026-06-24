# uds-did: ISO 14229 (UDS) standardized DataIdentifier names

Generic, standard meaning of UDS DataIdentifiers (DIDs): the 0xF18x/0xF19x
identification block (0xF190 VIN, 0xF18C ECUSerialNumber, ...) plus the
ISO 14229-1 DID address-space *range* categories (Periodic 0xF2xx,
DynamicallyDefined 0xF3xx, OBD 0xF4xx–0xF8xx, Tachograph 0xF9xx,
Airbag/Safety 0xFAxx, ReservedForLegislativeUse, SystemSupplierSpecific
0xFDxx–0xFExx, ISOSAEReserved, etc.), and a few DID-operating service refs
(0x10, 0x22, 0x2A, 0x2C, 0x2E, 0x3D).

This is **standard / structural** data only. No vehicle-specific DID values are
included; vehicle-manufacturer ranges appear only as range descriptors.

## Upstream

- URL: https://raw.githubusercontent.com/pylessard/python-udsoncan/master/udsoncan/common/dids.py
- Repo: https://github.com/pylessard/python-udsoncan (`udsoncan/common/dids.py`, `DataIdentifier` class)
- Cross-checked against the py-uds knowledge base DID table:
  https://uds.readthedocs.io/en/latest/pages/knowledge_base/did.html

## License

- MIT (SPDX: `MIT`): repo `LICENSE.txt`:
  https://github.com/pylessard/python-udsoncan/blob/master/LICENSE.txt
- Confirmed via GitHub license API (`spdx_id: MIT`).

## Retrieval

- Retrieved: 2026-06-24

## Build

- Parser: `parsers/ext_uds_did.mjs` (zero-dep Node ESM)
- Output: `build/external/uds_did_standard.ndjson`
- Row schema: `{ did, name, range_note, source }`
  - `did`: single id `0xF190`, inclusive range `0xF100-0xF17F`, or service ref `svc:0x22`
  - hex values are uppercase and `0x`-prefixed (universal join convention)
- Cross-links to `uds_service.did` (single-id rows join directly; range rows
  classify any DID that falls inside `[lo,hi]`).

## Provenance notes

- The 32 named 0xF180–0xF19F DIDs and all 20 range descriptors are transcribed
  verbatim from the MIT source `dids.py` (`DataIdentifier.name_from_id`).
- The 6 `svc:` service-ref rows are ISO 14229-1 standard service identifiers
  (structural, not fetched values), provided so the layer self-documents the
  read/write/periodic/dynamic DID services.
