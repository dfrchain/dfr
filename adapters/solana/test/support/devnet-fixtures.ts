/**
 * Real Solana devnet block transaction vectors (M3-A02 offline ground truth).
 *
 * Source: `getBlock` of devnet slot 508083216 (commitment=finalized,
 * maxSupportedTransactionVersion=1). `blockPayloadBase64` holds the raw on-chain transaction bytes (signed);
 * `accountKeys` / `header` / `recentBlockhash` / `instructionCount` / `numAddressTableLookups`
 * taken from the `encoding: json` parse of the same call — provided by a **chain node**, not by our implementation,
 * so it can independently verify the codec.
 *
 * All of this is **public on-chain data** (signatures and public keys), with no private keys or passwords.
 * Records that are v0 with `numAddressTableLookups > 0` pin the behavior "ALT needs on-chain resolution; this card fails closed".
 */
export interface SolanaFixtureTransaction {
  readonly version: 'legacy' | 'v0';
  readonly signature: string;
  readonly blockPayloadBase64: string;
  readonly accountKeys: readonly string[];
  readonly header: {
    readonly numRequiredSignatures: number;
    readonly numReadonlySignedAccounts: number;
    readonly numReadonlyUnsignedAccounts: number;
  };
  readonly recentBlockhash: string;
  readonly instructionCount: number;
  readonly numAddressTableLookups: number;
}

/** 4 representative records (2 legacy + 2 v0, one with an ALT lookup). */
export const SOLANA_DEVNET_FIXTURES: readonly SolanaFixtureTransaction[] = [
  {
    version: 'legacy',
    signature: '4Bd75QRBnVwyx2XUhN27xubcPfRJG6363u6ZP9kM8pi2fbvKZYyTSd6J7f2DeyriaVQxtiMUcvQKnsJ4kRokNavq',
    blockPayloadBase64: 'AZ82IG3I0GpZe5ryfAa/vUdo+1cyLCL8wCmr54O25iLcCKfFFS9DViOpUOYhlAKxhuQI3QYVyboQVSqh8AL3fg4BAAEDpfuA15Zqk/qY4T5fOJJqjQJFWiEN3b6ng7BW/vKk6Ralu+09sLiMvZ1GCVOUV1+C5cEQ7TWqe+DJqmPx3EeQnwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAmbYFp8v7etb4YKSGzSHXATfXOYfqXKdM8hll0xSuS7gBAgIAAQwCAAAAIU4AAAAAAAA=',
    accountKeys: [
      'CAvhesueQdL7D5BbFmhwzBJQntGQtotRDdyWkKMVCVmw',
      'C9xUTmzPc1YFJJTSViBeKsYV4u7sbxe9xNGkk8FisFnN',
      '11111111111111111111111111111111',
    ],
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 1,
    },
    recentBlockhash: 'BM2MpjjG9Wk6fzPVd62cCvYJFmPzZFxPVXX6g8NsqyDZ',
    instructionCount: 1,
    numAddressTableLookups: 0,
  },
  {
    version: 'legacy',
    signature: '5iFC2HnizCCXkhcBiKb1yESBGkBQ6dE5m3isZfXKTLsmRXtnsCoCDWycBSu8gWoMRQVAz5mifNSatpQxCYfXxWRB',
    blockPayloadBase64: 'AeuixQrPevIfHqSn7tikMKXORvqBGhLQUseg5PNzeZYaqsrPHouryyTXTyZdEx+WqUJxArrbO7krFrGkf7FSBQYBAAEDI+ANBdAYObtM0yTr6WBo8cxV+tYbf6yeaU76ENi/ZBnWuifz8Lf2qcRaa7j5A0PfWl2dM8IkS16+Q1Bq0JO3SgKo9pFOiKGw4hAVPvdjrisAwrk9FsEk0sBTehAEgAAAc3SGCWjIVt6kQ5PSLosg3262j6lsaeEA48Q/Qe7OEuMBAgIBAMYHAQAAAA6RBgC2AwAAAAAAAAAAhRAAAGnl//+VAAAAAAAAAL80AAAAAAAAvyMAAAAAAAAYAgAAMBgHAAAAAAAAAAAAhRAAAGno//+VAAAAAAAAAGIK/P8AAAAAv6QAAAAAAAAHBAAA/P///4UQAAD/////YaD8/wAAAABnAAAAIAAAAMcAAAAgAAAAlQAAAAAAAAC/FgAAAAAAAIUQAAD/////v2AAAAAAAACVAAAAAAAAAL8WAAAAAAAAhRAAAP////+/YAAAAAAAAJUAAAAAAAAAvxYAAAAAAABXAgAA/wAAAIUQAAD/////v2AAAAAAAACVAAAAAAAAAL85AAAAAAAAGAMAAFVVVVUAAAAAVVVVVRgAAAAzMzMzAAAAADMzMzMYCAAADw8PDwAAAAAPDw8Pe1r4/wAAAABVBVcAAAAAAL9HAAAAAAAAdwcAAAEAAAC/RgAAAAAAAE92AAAAAAAAv2cAAAAAAAB3BwAAAgAAAE92AAAAAAAAv2cAAAAAAAB3BwAABAAAAE92AAAAAAAAv2cAAAAAAAB3BwAACAAAAE92AAAAAAAAv2cAAAAAAAB3BwAAEAAAAE92AAAAAAAAv2cAAAAAAAB3BwAAIAAAAE92AAAAAAAApwYAAP////+/ZwAAAAAAAHcHAAABAAAAXzcAAAAAAAAfdgAAAAAAAL9jAAAAAAAAXwMAAAAAAAB3BgAAAgAAAF8GAAAAAAAAD2MAAAAAAAC/MAAAAAAAAHcAAAAEAAAADwMAAAAAAABfgwAAAAAAABgFAAABAQEBAAAAAAEBAQEvUwAAAAAAAHcDAAA4AAAABwMAAEAAAAC/JQAAAAAAAE+VAAAAAAAAFQVWAAAAAAAYBgAAVVVVVQAAAABVVVVVGAAAADMzMzMAAAAAMzMzMxgFAAAPDw8PAAAAAA8PDw9VCVEAAAAAAL8nAAAAAAAAdwcAAAEAAAC/KAAAAAAAAE94AAAAAAAAv4cAAAAAAAB3BwAAAgAAAE94AAAAAAAAv4cAAAAAAAB3BwAABAAAAE94AAAAAAAAv4cAAAAAAAB3BwAACAAAAE94AAAAAAAAv4cAAAAAAAB3BwAAEAAAAE94AAAAAAAAv4cAAAAAAAB3BwAAIAAAAE94AAAAAAAApwgAAP////+/hwAAAAAAAHcHAAABAAAAX2cAAAAAAAAfeAAAAAAAAL+HAAAAAAAAXwcAAAAAAAB3CAAAAgAAAF8IAAAAAAAAD4cAAAAAAAC/cAAAAAAAAHcAAAAEAAAADwcAAAAAAABfVwAA',
    accountKeys: [
      '3R3RRjoMKSzopaAsEwGoXZUNfXJ3sd4wwDxwLJL5x5Jx',
      'FTCtK6WbJMEoxww1P7cshmR4cdvbDEdufScWTMEBRsk5',
      'BPFLoaderUpgradeab1e11111111111111111111111',
    ],
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 1,
    },
    recentBlockhash: '8mgwUmRqUZ6GBJum9t1ECbFwX3qy1ye7NTEZuQVK2R5L',
    instructionCount: 1,
    numAddressTableLookups: 0,
  },
  {
    version: 'v0',
    signature: '4d1G3Vjhu7bnDvLTyNbf6EAFz1QVso94fEWa31C6Zwsuk2G7xqs11N1Qb8yc5HTCNJjGLatxLrf286MYyKXmGn2b',
    blockPayloadBase64: 'ArUZkg7CdntcqbVVS4PB73/fbgz1LfIGnIfd0nu7+USp7MIbV6kQT1ftXX7saFj7Kz+sS/Z3iSg0f75hxmQX3wiR3KoC6XCdEWElYdILlS25LxxrxGxLHxofH7GmUh2XY3uNtJluswaYvFjDBdoik7I2Cl82nUttPLtGujL0cPIOgAIABAdyYbkpdTV46un6uqIRk1S1CSFD/4WtdFvETSwDuVRKei+krQPjn21cka23dPWAmxQl1BQSAwx/PUD3WiLAtGuFwVMwxYNF8JDyo69NG5i2GzZCT8+LpC2ovawIZNk3OGYMt/p6XaYo+6ypmuqZ97873DaJaGAqv0FNToulZ7uwv9RkUn27XiL+CEvasNkFmhPhgnbaFLLdyTccmUYCBUU37llaw94GHU+B4G8ptpqClNpzzgHD7MQ2zpG0pWJkWw0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmUh+/6OFA/pKFIE8o9UyD9UIEK6McniF03CrszWUrAAQMHAAQFAgEGANYChV/PrwtPdixVAAAAAO8smMgEulA8anB+OL5N+7Fmg3dfGVsJElK/JGkwQv1SAAAAAAACaP4AAAAAAAAABP////0AAAAAasTgQgAAAABqxOBBAAAAAAACabMAAAAAAAAABQwAAAC/bgIUXIYGn5gekj2AJK9Ly8O2oQxLCHnqCrgUshmuvdadf3jMxTnNfltvVKSth+ab0HmOxHrtHultu0R/4pfoAV58kA2rPrzXL1rZEoB27J4NRxRxDvDivT9563/10B8758eh7kCg1Gs2Xk5mU2NjRGLh0qXT6L+oFjpPhIqbYLgI9tYTA4GmY0GF+Oc7H6HoApaeXuIyaWUnf9XO725dplhD/vM3tvpsdz87rmbo5mKIzJrXvLVyJwZ10e4KB0Dedxlvbow9knaNp6a3U6VDjDyVj6eOFCC8DBsusbqVGNf/nWnZmER5pUcSPNHHXongAA==',
    accountKeys: [
      '8hVuTo69CRiKdbbMDTKhymnXXAVi6zqCikLz4EuDZbjo',
      '4CyoWjhoLL6KGw1QxP4w1eKPL1xpnq5QJFZQdkrN4HYQ',
      'E1fG4uCxRMzDot8jpgs8tnNSnBdUMcAk3HXCLd7pSdnD',
      'rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp',
      'FJ6A8YZyktjH48katpUJuUdkmEHF7uocj3QD1aLWqBwc',
      'H3R4M45f2gyqp6geVUruapzZdyxpgGZ96UnWkDM3ndye',
      '11111111111111111111111111111111',
    ],
    header: {
      numRequiredSignatures: 2,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 4,
    },
    recentBlockhash: '2irZ8icXDWLKvmnvnUHeYubbUTyJFMZLJ5b1BL63iuzX',
    instructionCount: 1,
    numAddressTableLookups: 0,
  },
  {
    version: 'v0',
    signature: '3Nk5BSYdhFSyWTq1aQZqCvWML83iRETiQ6WM721tC2y61YHLXPH7NrPEZSYatG1WY1da3SpqL5rVvT4YwNWJddkm',
    blockPayloadBase64: 'AXbItMjQWX4QYnIb+VNYtRWBIf7QU3wYBoqpEd4maWtTksO0GoV7wSUz9gA4nOxSaJkHonEXLzJkSsT2NBqreQqAAQADBA0IkTMy7MyPnJ0YBcpTnq+0iOhqu2mDAfFK0lWzNqnPAwZGb+UhFzL/7K26csOb57yM5bvF9xJrLEObOkAAAAANCJhpqrvPqTXxHNjGWeSQH28KHZjM+ee3LVmryW0XqEVskRckSRN2/UdbkjB+wnVyK4QYoLfv1lm/TRS6tNIyiP7QAXSUJ+D+Ueaas4PuNyceAQXKY9iEPmyRMs6zWbUDAQAFAoIDAAABAAUEgIQeAAIOAAMMDgcKDQkLCAYEDwWoAgAAAAAMAAAADbxIHgAAAABt3StYVLXOGO/VAQDv1QEADbxIHgAAAAArrytYVLXOGHRBDwB0QQ8ADbxIHgAAAACI3StYVLXOGIEpDQCBKQ0ADbxIHgAAAACI3StYVLXOGKxkAgCsZAIADbxIHgAAAACH3StYVLXOGFVuAQBVbgEADbxIHgAAAABs3StYVLXOGCVVBQAlVQUADbxIHgAAAACH3StYVLXOGGTAAQBkwAEADbxIHgAAAACI3StYVLXOGEYWAgBGFgIADbxIHgAAAACI3StYVLXOGCJPAwAiTwMADbxIHgAAAACIrStYVLXOGP1BDwD9QQ8ADbxIHgAAAADktStYVLXOGJNCDwCTQg8ADbxIHgAAAACMrStYVLXOGFtDDwBbQw8AAcyqzy9h7U+W7Ag07vLQWhpatrqMI8UmVg3qDtw/En+GDAcLFw4WFBAVBRIMCgA=',
    accountKeys: [
      'ssss1Xi2xmCftispKEeXcvq7v63gwcq4VuuKFnvqZJ6',
      'ComputeBudget111111111111111111111111111111',
      'ssuJqL67UPz8vSZf2Rntp8iuSFCe1hy9GFNrdZEoJWs',
      '5g19bLUfbvqjSRnJdXhPgk9dtHavHsDAAHvLiYHnAdp5',
    ],
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 3,
    },
    recentBlockhash: 'ADmoewZgeyHAMrMXUx3QMUUNMHQcRB2pQC8p9R2fDQex',
    instructionCount: 3,
    numAddressTableLookups: 1,
  },
];

/**
 * A ready-made **really signed** legacy transaction (reused by broadcast/binding tests).
 *
 * It is public on-chain data: `signedPayloadBase64` holds the raw on-chain transaction bytes, `txHash` is signature 0,
 * `feePayer` is the first account. No private keys involved.
 */
export const SOLANA_DEVNET_LEGACY_SIGNED = {
  signedPayloadBase64: 'AZ82IG3I0GpZe5ryfAa/vUdo+1cyLCL8wCmr54O25iLcCKfFFS9DViOpUOYhlAKxhuQI3QYVyboQVSqh8AL3fg4BAAEDpfuA15Zqk/qY4T5fOJJqjQJFWiEN3b6ng7BW/vKk6Ralu+09sLiMvZ1GCVOUV1+C5cEQ7TWqe+DJqmPx3EeQnwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAmbYFp8v7etb4YKSGzSHXATfXOYfqXKdM8hll0xSuS7gBAgIAAQwCAAAAIU4AAAAAAAA=',
  txHash: '4Bd75QRBnVwyx2XUhN27xubcPfRJG6363u6ZP9kM8pi2fbvKZYyTSd6J7f2DeyriaVQxtiMUcvQKnsJ4kRokNavq',
  feePayer: 'CAvhesueQdL7D5BbFmhwzBJQntGQtotRDdyWkKMVCVmw',
  recentBlockhash: 'BM2MpjjG9Wk6fzPVd62cCvYJFmPzZFxPVXX6g8NsqyDZ',
  accountKeys: [
      'CAvhesueQdL7D5BbFmhwzBJQntGQtotRDdyWkKMVCVmw',
      'C9xUTmzPc1YFJJTSViBeKsYV4u7sbxe9xNGkk8FisFnN',
      '11111111111111111111111111111111',
  ],
} as const;
