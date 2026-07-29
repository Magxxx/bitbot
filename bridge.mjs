import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  formatUnits,
  getAddress,
  hashTypedData,
  http,
  pad,
  parseUnits,
  verifyTypedData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const GATEWAY_API = "https://gateway-api.circle.com";
const GATEWAY_WALLET = getAddress(
  "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
);
const GATEWAY_MINTER = getAddress(
  "0x2222222d7164433c4C09B0b0D809a9b52C04C205",
);
const ARC_USDC = getAddress("0x3600000000000000000000000000000000000000");
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ARC_RPC = "https://rpc.blockdaemon.mainnet.arc.io";
const ARC_DOMAIN = 26;
const ARC_CHAIN_ID = 5042;
const MAX_TRANSFER_RAW = 500_000_000n;
const MAX_GATEWAY_FEE_RAW = 5_000_000n;
const ARC_MINIMUM_RELAYER_GAS_RAW = 10_000_000_000_000_000n;
const PRIVATE_ARC_HEADERS = {
  "content-type": "application/json",
  "X-ARC-PRIVATE-MAINNET-ENABLED": "true",
};

const SOURCE_CHAINS = {
  base: {
    id: 8453,
    name: "Base",
    domain: 6,
    rpc: "https://base-mainnet.public.blastapi.io",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    usdc: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    confirmationTimeoutMs: 120_000,
  },
  ethereum: {
    id: 1,
    name: "Ethereum",
    domain: 0,
    rpc: "https://ethereum-rpc.publicnode.com",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    usdc: getAddress("0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
    confirmationTimeoutMs: 300_000,
  },
};

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "allowance", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "success", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
];

const gatewayWalletAbi = [
  {
    type: "function",
    name: "deposit",
    inputs: [
      { name: "token", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
];

const gatewayMinterAbi = [
  {
    type: "function",
    name: "gatewayMint",
    inputs: [
      { name: "attestationPayload", type: "bytes" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
];

const gatewayEip712Domain = {
  name: "GatewayWallet",
  version: "1",
};

const gatewayEip712Types = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
  ],
  TransferSpec: [
    { name: "version", type: "uint32" },
    { name: "sourceDomain", type: "uint32" },
    { name: "destinationDomain", type: "uint32" },
    { name: "sourceContract", type: "bytes32" },
    { name: "destinationContract", type: "bytes32" },
    { name: "sourceToken", type: "bytes32" },
    { name: "destinationToken", type: "bytes32" },
    { name: "sourceDepositor", type: "bytes32" },
    { name: "destinationRecipient", type: "bytes32" },
    { name: "sourceSigner", type: "bytes32" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "value", type: "uint256" },
    { name: "salt", type: "bytes32" },
    { name: "hookData", type: "bytes" },
  ],
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "spec", type: "TransferSpec" },
  ],
};

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function privateKey(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte private key`);
  }
  return value;
}

function bytes32Address(address) {
  return pad(getAddress(address), { size: 32 });
}

function parseAmount(value) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) {
    throw new Error("AMOUNT_USDC must be a positive decimal with <=6 places");
  }
  const raw = parseUnits(value, 6);
  if (raw <= 0n || raw > MAX_TRANSFER_RAW) {
    throw new Error("AMOUNT_USDC must be greater than zero and at most 500");
  }
  return raw;
}

function stateFile(operationId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(operationId)) {
    throw new Error("OPERATION_ID has invalid characters or length");
  }
  return resolve("bridge-state", `${operationId}.json`);
}

function readState(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function saveState(path, state) {
  mkdirSync(resolve("bridge-state"), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
}

async function gatewayRequest(path, init = {}) {
  const response = await fetch(`${GATEWAY_API}${path}`, {
    ...init,
    headers: { ...PRIVATE_ARC_HEADERS, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Gateway HTTP ${response.status} returned non-JSON`);
  }
  if (!response.ok || json?.success === false) {
    throw new Error(
      `Gateway HTTP ${response.status}: ${json?.message ?? text}`,
    );
  }
  return json;
}

function decimalToRaw(value) {
  return parseUnits(value, 6);
}

async function gatewayBalanceRaw(chain, depositor) {
  const json = await gatewayRequest("/v1/balances", {
    method: "POST",
    body: JSON.stringify({
      token: "USDC",
      sources: [{ domain: chain.domain, depositor }],
    }),
  });
  const balance = json.balances?.find(
    (item) =>
      item.domain === chain.domain &&
      getAddress(item.depositor) === depositor,
  )?.balance;
  if (typeof balance !== "string") {
    throw new Error("Gateway balance response is missing the source wallet");
  }
  return decimalToRaw(balance);
}

function buildSpec(chain, depositor, recipient, amountRaw, salt) {
  return {
    version: 1,
    sourceDomain: chain.domain,
    destinationDomain: ARC_DOMAIN,
    sourceContract: bytes32Address(GATEWAY_WALLET),
    destinationContract: bytes32Address(GATEWAY_MINTER),
    sourceToken: bytes32Address(chain.usdc),
    destinationToken: bytes32Address(ARC_USDC),
    sourceDepositor: bytes32Address(depositor),
    destinationRecipient: bytes32Address(recipient),
    sourceSigner: bytes32Address(depositor),
    destinationCaller: bytes32Address(ZERO_ADDRESS),
    value: amountRaw.toString(),
    salt,
    hookData: "0x",
  };
}

function normalizeSpecValue(field, value) {
  const addressFields = new Set([
    "sourceContract",
    "destinationContract",
    "sourceToken",
    "destinationToken",
    "sourceDepositor",
    "destinationRecipient",
    "sourceSigner",
    "destinationCaller",
  ]);
  if (addressFields.has(field)) return String(value).slice(-40).toLowerCase();
  return String(value).toLowerCase();
}

function verifyEstimatedSpec(requested, returned) {
  for (const [field, expected] of Object.entries(requested)) {
    if (
      normalizeSpecValue(field, expected) !==
      normalizeSpecValue(field, returned[field])
    ) {
      throw new Error(`Gateway estimate changed ${field}`);
    }
  }
}

async function estimate(chain, depositor, recipient, amountRaw, salt) {
  const spec = buildSpec(chain, depositor, recipient, amountRaw, salt);
  const json = await gatewayRequest("/v1/estimate", {
    method: "POST",
    body: JSON.stringify([{ spec }]),
  });
  const burnIntent = json?.[0]?.burnIntent;
  if (!burnIntent?.spec) throw new Error("Gateway estimate shape changed");
  verifyEstimatedSpec(spec, burnIntent.spec);
  const maxFee = BigInt(burnIntent.maxFee);
  const maxBlockHeight = BigInt(burnIntent.maxBlockHeight);
  if (maxFee <= 0n || maxFee > MAX_GATEWAY_FEE_RAW) {
    throw new Error("quoted Gateway fee exceeds the 5 USDC cap");
  }
  return { spec, maxFee, maxBlockHeight };
}

async function waitReceipt(client, hash, timeout) {
  const receipt = await client.waitForTransactionReceipt({
    hash,
    confirmations: 2,
    timeout,
  });
  if (receipt.status !== "success") throw new Error(`${hash} reverted`);
  return receipt;
}

function verifyDepositTransfer(receipt, chain, depositor, amountRaw) {
  let transferred = 0n;
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== chain.usdc) continue;
    try {
      const event = decodeEventLog({
        abi: erc20Abi,
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      if (
        event.eventName === "Transfer" &&
        getAddress(event.args.from) === depositor &&
        getAddress(event.args.to) === GATEWAY_WALLET
      ) {
        transferred += event.args.value;
      }
    } catch {
      // Ignore unrelated logs.
    }
  }
  if (transferred !== amountRaw) {
    throw new Error(`deposit receipt transferred ${transferred}, expected ${amountRaw}`);
  }
}

async function ensureFinalizedBalance({
  chain,
  depositor,
  requiredRaw,
  autoDeposit,
  publicClient,
  walletClient,
  account,
  state,
  statePath,
}) {
  let finalized = await gatewayBalanceRaw(chain, depositor);
  if (finalized >= requiredRaw) return finalized;
  if (!autoDeposit) {
    throw new Error(
      `finalized Gateway balance ${formatUnits(finalized, 6)} is below ` +
        `${formatUnits(requiredRaw, 6)} USDC`,
    );
  }

  const deficit = requiredRaw - finalized;
  if (state.depositAmountRaw && BigInt(state.depositAmountRaw) !== deficit) {
    throw new Error("persisted deposit amount differs from current shortfall");
  }
  const sourceBalance = await publicClient.readContract({
    address: chain.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [depositor],
  });
  if (sourceBalance < deficit) {
    throw new Error(
      `source wallet has ${formatUnits(sourceBalance, 6)} USDC; ` +
        `${formatUnits(deficit, 6)} is required`,
    );
  }
  state.depositAmountRaw ??= deficit.toString();
  saveState(statePath, state);

  const allowance = await publicClient.readContract({
    address: chain.usdc,
    abi: erc20Abi,
    functionName: "allowance",
    args: [depositor, GATEWAY_WALLET],
  });
  if (allowance < deficit && !state.approvalTx) {
    const simulation = await publicClient.simulateContract({
      account,
      address: chain.usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [GATEWAY_WALLET, deficit],
    });
    state.approvalTx = await walletClient.writeContract(simulation.request);
    saveState(statePath, state);
    console.log(`Approval submitted: ${state.approvalTx}`);
  }
  if (state.approvalTx) {
    await waitReceipt(
      publicClient,
      state.approvalTx,
      chain.confirmationTimeoutMs,
    );
  }

  if (!state.depositTx) {
    const simulation = await publicClient.simulateContract({
      account,
      address: GATEWAY_WALLET,
      abi: gatewayWalletAbi,
      functionName: "deposit",
      args: [chain.usdc, deficit],
    });
    state.depositTx = await walletClient.writeContract(simulation.request);
    saveState(statePath, state);
    console.log(`Gateway deposit submitted: ${state.depositTx}`);
  }
  const receipt = await waitReceipt(
    publicClient,
    state.depositTx,
    chain.confirmationTimeoutMs,
  );
  verifyDepositTransfer(receipt, chain, depositor, deficit);
  console.log(
    `Deposit confirmed at ${chain.name} block ${receipt.blockNumber}. ` +
      "Waiting for Circle finality (normally 13–19 minutes)...",
  );

  for (;;) {
    finalized = await gatewayBalanceRaw(chain, depositor);
    if (finalized >= requiredRaw) return finalized;
    console.log(
      `${new Date().toISOString()} finalized Gateway balance: ` +
        `${formatUnits(finalized, 6)} USDC`,
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15_000));
  }
}

function verifyMintReceipt(receipt, recipient, amountRaw) {
  let minted = 0n;
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== ARC_USDC) continue;
    try {
      const event = decodeEventLog({
        abi: erc20Abi,
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      if (
        event.eventName === "Transfer" &&
        getAddress(event.args.from) === getAddress(ZERO_ADDRESS) &&
        getAddress(event.args.to) === recipient
      ) {
        minted += event.args.value;
      }
    } catch {
      // Ignore unrelated logs.
    }
  }
  if (minted !== amountRaw) {
    throw new Error(`Arc receipt minted ${minted}, expected ${amountRaw}`);
  }
}

const sourceChainName = required("SOURCE_CHAIN").toLowerCase();
const sourceChain = SOURCE_CHAINS[sourceChainName];
if (!sourceChain) throw new Error("SOURCE_CHAIN must be base or ethereum");
const amountRaw = parseAmount(required("AMOUNT_USDC"));
const operationId = required("OPERATION_ID");
const sourceKey = privateKey("EVM_PRIVATE_KEY");
const relayerKey = privateKey("ARC_RELAYER_PRIVATE_KEY", sourceKey);
const sourceAccount = privateKeyToAccount(sourceKey);
const relayerAccount = privateKeyToAccount(relayerKey);
const depositor = getAddress(sourceAccount.address);
const recipient = getAddress(process.env.DESTINATION_ADDRESS ?? depositor);
const autoDeposit = (process.env.AUTO_DEPOSIT ?? "true") === "true";
const path = stateFile(operationId);
const state = readState(path);

for (const [field, value] of Object.entries({
  sourceChain: sourceChainName,
  depositor,
  recipient,
  amountRaw: amountRaw.toString(),
})) {
  if (state[field] !== undefined && state[field] !== value) {
    throw new Error(`persisted operation contradicts ${field}`);
  }
  state[field] = value;
}
saveState(path, state);

const sourceViemChain = {
  id: sourceChain.id,
  name: sourceChain.name,
  nativeCurrency: sourceChain.nativeCurrency,
  rpcUrls: { default: { http: [sourceChain.rpc] } },
};
const arcChain = {
  id: ARC_CHAIN_ID,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC] } },
};
const sourcePublicClient = createPublicClient({
  chain: sourceViemChain,
  transport: http(sourceChain.rpc),
});
const sourceWalletClient = createWalletClient({
  account: sourceAccount,
  chain: sourceViemChain,
  transport: http(sourceChain.rpc),
});
const arcPublicClient = createPublicClient({
  chain: arcChain,
  transport: http(ARC_RPC),
});
const arcWalletClient = createWalletClient({
  account: relayerAccount,
  chain: arcChain,
  transport: http(ARC_RPC),
});

const initialSalt =
  state.initialSalt ?? `0x${randomBytes(32).toString("hex")}`;
state.initialSalt = initialSalt;
const initialEstimate = await estimate(
  sourceChain,
  depositor,
  recipient,
  amountRaw,
  initialSalt,
);
const requiredGatewayRaw = amountRaw + initialEstimate.maxFee;
await ensureFinalizedBalance({
  chain: sourceChain,
  depositor,
  requiredRaw: requiredGatewayRaw,
  autoDeposit,
  publicClient: sourcePublicClient,
  walletClient: sourceWalletClient,
  account: sourceAccount,
  state,
  statePath: path,
});

if (!state.gatewayResponse) {
  const salt = `0x${randomBytes(32).toString("hex")}`;
  const fresh = await estimate(
    sourceChain,
    depositor,
    recipient,
    amountRaw,
    salt,
  );
  const sourceBlock = await sourcePublicClient.getBlockNumber();
  if (fresh.maxBlockHeight <= sourceBlock) {
    throw new Error("fresh Gateway estimate is already expired");
  }
  const available = await gatewayBalanceRaw(sourceChain, depositor);
  if (available < amountRaw + fresh.maxFee) {
    throw new Error("finalized Gateway balance cannot cover fresh quote");
  }
  const message = {
    maxBlockHeight: fresh.maxBlockHeight,
    maxFee: fresh.maxFee,
    spec: { ...fresh.spec, value: amountRaw },
  };
  const signature = await sourceAccount.signTypedData({
    domain: gatewayEip712Domain,
    types: gatewayEip712Types,
    primaryType: "BurnIntent",
    message,
  });
  const valid = await verifyTypedData({
    address: depositor,
    domain: gatewayEip712Domain,
    types: gatewayEip712Types,
    primaryType: "BurnIntent",
    message,
    signature,
  });
  if (!valid) throw new Error("local BurnIntent signature failed verification");
  state.burnIntentHash = hashTypedData({
    domain: gatewayEip712Domain,
    types: gatewayEip712Types,
    primaryType: "BurnIntent",
    message,
  });
  state.apiBurnIntent = {
    maxBlockHeight: fresh.maxBlockHeight.toString(),
    maxFee: fresh.maxFee.toString(),
    spec: fresh.spec,
  };
  state.burnSignature = signature;
  saveState(path, state);

  state.gatewayResponse = await gatewayRequest("/v1/transfer", {
    method: "POST",
    body: JSON.stringify([
      {
        burnIntent: state.apiBurnIntent,
        signature: state.burnSignature,
      },
    ]),
  });
  if (
    !/^0x[0-9a-fA-F]+$/.test(state.gatewayResponse.attestation ?? "") ||
    !/^0x[0-9a-fA-F]{130}$/.test(state.gatewayResponse.signature ?? "")
  ) {
    throw new Error("Gateway response is missing attestation material");
  }
  saveState(path, state);
  console.log(`Gateway transfer ID: ${state.gatewayResponse.transferId}`);
}

if (!state.arcMintTx) {
  const relayerGas = await arcPublicClient.getBalance({
    address: relayerAccount.address,
  });
  if (relayerGas < ARC_MINIMUM_RELAYER_GAS_RAW) {
    throw new Error(
      "Arc relayer needs at least 0.01 native USDC for gatewayMint gas",
    );
  }
  const simulation = await arcPublicClient.simulateContract({
    account: relayerAccount,
    address: GATEWAY_MINTER,
    abi: gatewayMinterAbi,
    functionName: "gatewayMint",
    args: [
      state.gatewayResponse.attestation,
      state.gatewayResponse.signature,
    ],
  });
  state.arcMintTx = await arcWalletClient.writeContract(simulation.request);
  saveState(path, state);
  console.log(`Arc mint submitted: ${state.arcMintTx}`);
}

const mintReceipt = await waitReceipt(
  arcPublicClient,
  state.arcMintTx,
  180_000,
);
verifyMintReceipt(mintReceipt, recipient, amountRaw);
state.completed = true;
state.arcMintBlock = mintReceipt.blockNumber.toString();
saveState(path, state);
console.log(
  JSON.stringify(
    {
      status: "completed",
      sourceChain: sourceChain.name,
      depositor,
      recipient,
      amountUsdc: formatUnits(amountRaw, 6),
      gatewayTransferId: state.gatewayResponse.transferId,
      arcMintTx: state.arcMintTx,
      arcMintBlock: state.arcMintBlock,
    },
    null,
    2,
  ),
);
