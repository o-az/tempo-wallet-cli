import Foundation
import Security

// Native bridge for signing Tempo key-authorizations with a macOS Secure Enclave root key.
//
// The CLI creates Secure Enclave roots through `sc_auth create-ctk-identity`, but
// `sc_auth` does not expose a command for "sign this 32-byte digest". Node also
// cannot read the private key because P-256 Secure Enclave keys are intentionally
// non-exportable. This helper uses Security.framework to find the CTK identity by
// certificate label, obtain its SecKeyRef, and ask macOS/Secure Enclave to sign.
//
// `tempo wallet keys create` calls this helper after it has generated an
// exportable local secp256k1 access key and built the Tempo `KeyAuthorization`
// sign payload. The helper returns JSON with the root public key and DER ECDSA
// signature; TypeScript parses that into a Tempo P-256 `SignatureEnvelope`.
// The root private key never leaves the Secure Enclave.

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

func hexToData(_ input: String) -> Data? {
  var hex = input
  if hex.hasPrefix("0x") {
    hex.removeFirst(2)
  }
  guard hex.count % 2 == 0 else { return nil }

  var data = Data()
  var index = hex.startIndex
  while index < hex.endIndex {
    let next = hex.index(index, offsetBy: 2)
    guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
    data.append(byte)
    index = next
  }
  return data
}

func hex(_ data: Data) -> String {
  data.map { String(format: "%02x", $0) }.joined()
}

func findIdentity(label: String) -> (SecIdentity, SecCertificate) {
  let query: [String: Any] = [
    kSecClass as String: kSecClassIdentity,
    kSecReturnRef as String: true,
    kSecMatchLimit as String: kSecMatchLimitAll,
  ]

  var result: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &result)
  guard status == errSecSuccess, let identities = result as? [SecIdentity] else {
    fail("No Secure Enclave identities available: \(status).")
  }

  for identity in identities {
    var certificate: SecCertificate?
    SecIdentityCopyCertificate(identity, &certificate)
    guard let certificate else { continue }
    let summary = SecCertificateCopySubjectSummary(certificate) as String?
    if summary == label {
      return (identity, certificate)
    }
  }

  fail("Secure Enclave identity '\(label)' was not found.")
}

guard CommandLine.arguments.count == 3 else {
  fail("Usage: macos-secure-enclave-sign.swift <identity-label> <32-byte-digest-hex>")
}

let label = CommandLine.arguments[1]
guard let digest = hexToData(CommandLine.arguments[2]), digest.count == 32 else {
  fail("Expected a 32-byte digest.")
}

let (identity, certificate) = findIdentity(label: label)

var privateKey: SecKey?
let keyStatus = SecIdentityCopyPrivateKey(identity, &privateKey)
guard keyStatus == errSecSuccess, let privateKey else {
  fail("Unable to load Secure Enclave private key: \(keyStatus).")
}

guard let publicKey = SecCertificateCopyKey(certificate) else {
  fail("Unable to load Secure Enclave public key.")
}

var publicKeyError: Unmanaged<CFError>?
guard let publicKeyData = SecKeyCopyExternalRepresentation(publicKey, &publicKeyError) as Data? else {
  fail("Unable to export Secure Enclave public key: \(String(describing: publicKeyError?.takeRetainedValue())).")
}

let algorithm = SecKeyAlgorithm.ecdsaSignatureDigestX962SHA256
guard SecKeyIsAlgorithmSupported(privateKey, .sign, algorithm) else {
  fail("Secure Enclave identity does not support ECDSA P-256 digest signing.")
}

var signatureError: Unmanaged<CFError>?
guard let signature = SecKeyCreateSignature(privateKey, algorithm, digest as CFData, &signatureError) as Data? else {
  fail("Secure Enclave signing failed: \(String(describing: signatureError?.takeRetainedValue())).")
}

let output = [
  "publicKey": "0x" + hex(publicKeyData),
  "signature": "0x" + hex(signature),
]

let json = try JSONSerialization.data(withJSONObject: output)
FileHandle.standardOutput.write(json)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
