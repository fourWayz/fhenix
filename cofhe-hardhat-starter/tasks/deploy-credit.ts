import { task } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { saveDeployment } from './utils'

task('deploy-credit', 'Deploy CreditScoreRegistry, LendingPool, and CreditTierNFT').setAction(
  async (_, hre: HardhatRuntimeEnvironment) => {
    const { ethers, network } = hre

    console.log(`Deploying credit protocol to ${network.name}...`)
    const [deployer] = await ethers.getSigners()
    console.log(`Deploying with account: ${deployer.address}`)

    // CreditScoreRegistry
    const Registry = await ethers.getContractFactory('CreditScoreRegistry')
    const registry = await Registry.deploy()
    await registry.waitForDeployment()
    const registryAddress = await registry.getAddress()
    console.log(`CreditScoreRegistry deployed to: ${registryAddress}`)
    saveDeployment(network.name, 'CreditScoreRegistry', registryAddress)

    // LendingPool (depends on registry)
    const Pool = await ethers.getContractFactory('LendingPool')
    const pool = await Pool.deploy(registryAddress)
    await pool.waitForDeployment()
    const poolAddress = await pool.getAddress()
    console.log(`LendingPool deployed to: ${poolAddress}`)
    saveDeployment(network.name, 'LendingPool', poolAddress)

    // CreditTierNFT (depends on registry — reads revealed rates)
    const NFT = await ethers.getContractFactory('CreditTierNFT')
    const nft = await NFT.deploy(registryAddress)
    await nft.waitForDeployment()
    const nftAddress = await nft.getAddress()
    console.log(`CreditTierNFT deployed to: ${nftAddress}`)
    saveDeployment(network.name, 'CreditTierNFT', nftAddress)

    console.log('\n--- Deployment summary ---')
    console.log(JSON.stringify({ CreditScoreRegistry: registryAddress, LendingPool: poolAddress, CreditTierNFT: nftAddress }, null, 2))

    return { registryAddress, poolAddress, nftAddress }
  },
)
