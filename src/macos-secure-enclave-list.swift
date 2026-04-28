import Foundation
import Security

// Lists Tempo-owned macOS Secure Enclave identities without exposing or signing
// with their private keys. The TypeScript CLI uses this for `tempo wallet list`
// and `tempo wallet import --address ...`: users identify hardware wallets by
// Tempo address, while CTK labels remain an internal lookup detail.

func hex(_ data: Data) -> String {
  data.map { String(format: "%02x", $0) }.joined()
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

let query: [String: Any] = [
  kSecClass as String: kSecClassIdentity,
  kSecReturnRef as String: true,
  kSecMatchLimit as String: kSecMatchLimitAll,
]

var result: CFTypeRef?
let status = SecItemCopyMatching(query as CFDictionary, &result)
if status == errSecItemNotFound {
  print("[]")
  exit(0)
}
guard status == errSecSuccess, let identities = result as? [SecIdentity] else {
  fail("Unable to list Secure Enclave identities: \(status).")
}

var output: [[String: String]] = []
for identity in identities {
  var certificate: SecCertificate?
  SecIdentityCopyCertificate(identity, &certificate)
  guard let certificate else { continue }
  guard let label = SecCertificateCopySubjectSummary(certificate) as String? else { continue }
  guard label.hasPrefix("tempo_wallet_") else { continue }
  guard let publicKey = SecCertificateCopyKey(certificate) else { continue }

  var error: Unmanaged<CFError>?
  guard let publicKeyData = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
    continue
  }

  output.append([
    "hash": "",
    "label": label,
    "publicKey": "0x" + hex(publicKeyData),
  ])
}

let json = try JSONSerialization.data(withJSONObject: output)
FileHandle.standardOutput.write(json)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
