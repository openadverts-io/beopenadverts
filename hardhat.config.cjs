/* global ethers task */
require("@nomicfoundation/hardhat-toolbox");
// Load .env by default; set ENV_FILE=.env.prod for Polygon-mainnet/prod operations.
require("dotenv").config({ path: process.env.ENV_FILE || ".env" });
require("hardhat-contract-sizer");
require("hardhat-gas-reporter");

// This is a sample Hardhat task. To learn how to create your own go to
// https://hardhat.org/guides/create-task.html
task("accounts", "Prints the list of accounts", async () => {
  const accounts = await ethers.getSigners();

  for (const account of accounts) {
    console.log(account.address);
  }
});

// You need to export an object to set up your config
// Go to https://hardhat.org/config/ to learn more

/**
 * @type import('hardhat/config').HardhatUserConfig
 */

// const GOERLI_RPC_URL = process.env.GOERLI_RPC_URL;
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL;
// const AMOY_RPC_URL = process.env.AMOY_RPC_URL;

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const PRIVATE_KEY_HH1 = process.env.PRIVATE_KEY_HH1;
// Dedicated mainnet deployer/owner key — kept separate from PRIVATE_KEY so a
// testnet/dev key can never accidentally become the Polygon protocol owner.
const PRIVATEKEYMAINNET = process.env.PRIVATEKEYMAINNET;

const INFURA_API_KEY = process.env.INFURA_API_KEY;
// Etherscan V2 uses one unified API key across all chains (incl. Polygon/Amoy),
// so a single ETHERSCAN_API_KEY drives `hardhat verify` everywhere.
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;

module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.22",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
    ],
    overrides: {
      // OpenAdvertsGovernanceFacet is near the 24 KB EIP-170 limit.
      // runs: 1 optimises for deployment size over runtime gas.
      "contracts/facets/OpenAdvertsGovernanceFacet.sol": {
        version: "0.8.22",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1,
          },
          viaIR: true,
        },
      },
      // OpenAdvertsAdvertUSDCFactoryFacet absorbed the deploy logic previously
      // in OpenAdvertsAdvertUSDCHelperFacet (Tier 1 tx.origin refactor).
      // runs: 1 optimises for deployment size over runtime gas.
      "contracts/facets/OpenAdvertsAdvertUSDCFactoryFacet.sol": {
        version: "0.8.22",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1,
          },
          viaIR: true,
        },
      },
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  // This ensures test contracts are also compiled
  contracts: ["./contracts/**/*.sol"],
  gasReporter: {
    enabled: true,
    // currency: "USD", // Optional: for cost estimation
    // gasPrice: 21, // Optional: specify gas price in gwei
  },
  networks: {
    sepolia: {
      url: `https://sepolia.infura.io/v3/${INFURA_API_KEY}`,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 11155111,
    },
    polygon: {
      // Falls back to a public RPC so the config parses in dev; actual mainnet
      // ops require ENV_FILE=.env.prod where POLYGON_RPC_URL is set properly.
      url: POLYGON_RPC_URL || "https://polygon-rpc.com",
      accounts: PRIVATEKEYMAINNET ? [PRIVATEKEYMAINNET] : [],
      chainId: 137,
    },
    // amoy: {
    //   url: AMOY_RPC_URL,
    //   accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    //   chainId: 80002,
    // },
    // goerli: {
    //   url: GOERLI_RPC_URL,
    //   accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    //   chainId: 5,
    // },
    // rinkeby: {
    //   url: "RINKEBY_RPC_URL",
    //   accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    //   chainId: 4,
    // },
    hardhat: {
      chainId: 1337, // ✅ ADD: Set hardhat network to 31337
      accounts: {
        count: 200,
        accountsBalance: "100000000000000000000000000", // 100,000,000 ETH each
        mnemonic: "test test test test test test test test test test test junk",
      },
      blockGasLimit: 50000000,
      allowUnlimitedContractSize: true,
      initialBaseFeePerGas: 1_000_000_000,
      hardfork: "london",
      mining: {
        auto: true,
        interval: 0,
      },
    },
    localhost: {
      url: "http://127.0.0.1:8545/",
      chainId: 1337, // ✅ Keep as 31337
      accounts: PRIVATE_KEY_HH1 ? [PRIVATE_KEY_HH1] : [],
      hardfork: "london",
    },
  },
  // Used by `hardhat verify` / the verifyDeployment() step in scripts/deploy.js.
  // Etherscan V2 multichain API: one key verifies Polygon, Amoy, etc.
  etherscan: {
    apiKey: ETHERSCAN_API_KEY || "",
  },
  // ✅ Increase timeout for gas stress tests
  mocha: {
    timeout: 600000, // 10 minutes
  },
};
