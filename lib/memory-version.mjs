// Bump when extraction, profile, archival, recall, or memory layout semantics
// change incompatibly and the lab should start with clean test data.
export const MEMORY_FRAMEWORK_VERSION = 6;

// Explicitly authorized data-preserving adoptions of deployed fingerprints.
// Unknown fingerprints still follow activateVersion's reset guard.
export const MEMORY_COMPATIBLE_DATA_VERSIONS = Object.freeze({
  5: Object.freeze(['750cae7b3bcf25c2f9e9fff8c8892c8edeee25deeb5767bf7bbbe0c89703d7be']),
  6: Object.freeze([
    '326cb06b722e5ccb72f7024336c5bc52b103ee259a4eecea1306fa9c77a91c42',
    '677fa5fb30317b57c448463a4bc0fd36ad271a3d9c351dc5656493e81f23ccb8',
    // Additive character release: existing role prompts and memory semantics
    // match this deployed 1.3.2 fingerprint; retain its data without reset.
    'ad087545c4ed5a43f5b686606486629ce75f8b1835820299c8193b3706076ba2',
    // 1.3.4 changes only shared chat guidance and tool descriptions. The user
    // explicitly requires preserving all existing 1.3.3 records and memories.
    'c90a3f1f13b4c36acabfc9c73a1ea1991d111b8185c3e24c9a242cb4dba7fb7d',
    // 1.3.5 updates public-information guidance and same-session search-result
    // reuse. Preserve the authorized deployed 1.3.4 data and memory contents.
    'ae4598eaebd0280b9d5e0318b3aa83eb0f8dbd616b61eee433c25c6e2f80b316',
    // 1.3.6 changes only shared answer-length guidance. Keep the explicitly
    // authorized deployed 1.3.5 records, including conversation contexts.
    '6a977c6d15984470760035730a8b665496a0a9480ea0ab09aa4ef1f46c5f0a73',
    // Adult-character update retains existing users, ordinary roles and memory.
    'c4e9387777b9ff19269ad2cb1e9e7aafb0b7bf2dfd498f10a9860aa97b55d6b8',
    // Preserve completed 1.3.7 role/audience changes and all user data while
    // refining only the shared scope and length of post-tool answers.
    'b124979c5e73ec40aab8583f84ef10178a055e74e7a9885153c9c077c9458bc7',
    // Refine only Xiaoman's dialogue style; preserve deployed 1.3.8 data.
    'e2c5eb8a4cc38d4707ff770a43ea137ebfffbc5a15571fa82fb0014ce2a7d494',
    // Remove Xiaoman's forced split-message style; retain deployed data.
    '96d167a946ef3852a0900a3f06df93a5bc19901e94f257854f84c05f2fb9534b',
    // Let Xiaoman choose natural message breaks; retain deployed 1.3.10 data.
    '119dd775b8807574ea6bd91ba9dbfe39a153af811876d2a621607496bc9a1291',
    // Rework Xiaoman's character focus, preserving deployed records and memory.
    '2c2802f8944d69b0e5c5d027f40e858e44d72524fe1c189818ef55ae3b21e9ec',
    // Trial Benny's single-text role definition while retaining all deployed
    // 1.3.12 users, conversations, memories and their existing role IDs.
    '760e21c0068a87b4a3cc150a0beef67271e6db80215b918be29862643daabb61',
    // Adopt deployed 1.3.15 into database roles without resetting existing records.
    '1d6d4253c510af3ed22c772aa2b93987f5448dec7eb00a0cca977096fba80fc2',
    // Local greeting/turn-length guidance changes no memory schema or records.
    // Adopt the verified running 4334 fingerprint without resetting user data.
    '2eca21aaf28e0ab41289b5f63a552e36da0cf7ceee2bf041a618b9e68ed6160c',
    // Clarify that historical style preferences are context, not a new task.
    // Preserve the first deployed greeting-guidance revision and its records.
    'be076f8b44ee99107d303707184d6dd647e64fdf2640c4850f6b43f29db66222',
  ]),
});
