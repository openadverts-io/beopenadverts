const { expect } = require("chai")
const { ethers } = require("hardhat")
const { deployDiamond } = require("../../scripts/deploy.js")
const gate = require("../helpers/signatureGate.js")

describe("DesignatedAffiliate Binding Tests", function () {
    let advertPOLFactoryFacet
    let advertUSDCFactoryFacet
    let advertisersFacet
    let affiliatesFacet
    let affiliatesVotingFacet
    let tokenFacet
    let mockUSDC

    let owner
    let advertiser
    let voter1
    let voter2
    let voter3
    let approvedAffiliate
    let prospectAffiliate
    let outsider
    let signing1
    let signing2
    let approvedAffiliateAddress
    let diamondAddress
    let gateSigner

    const INITIAL_FUNDING_POL = ethers.parseEther("3000.0")
    const BOUNTY_POL = ethers.parseEther("0.1")
    const BOUNTY_USDC = 100_000_000n
    const FUNDING_USDC = 2_000_000_000n

    async function mineBlocks(count) {
        for (let i = 0; i < count; i++) {
            await ethers.provider.send("evm_mine", [])
        }
    }

    async function createAndApproveAffiliate(affiliateSigner, signingAddress) {
        await affiliatesFacet.connect(affiliateSigner).createProspectAffiliateContract(
            affiliateSigner.address,
            affiliateSigner.address,
            signingAddress,
            "approved-aff-storage",
            ...(await gate.affiliate(gateSigner, diamondAddress, affiliateSigner.address)))

        await mineBlocks(15)
        await affiliatesVotingFacet.connect(owner).voteOnAffiliate(affiliateSigner.address, true)
        await affiliatesVotingFacet.connect(voter1).voteOnAffiliate(affiliateSigner.address, true)
        await affiliatesVotingFacet.connect(voter2).voteOnAffiliate(affiliateSigner.address, true)

        const status = await affiliatesFacet.getAffiliateStatus(affiliateSigner.address)
        expect(status).to.equal(1)
    }

    before(async function () {
        const deployedAddresses = await deployDiamond()
        const signers = await ethers.getSigners()

        owner = signers[0]
        advertiser = signers[1]
        voter1 = signers[2]
        voter2 = signers[3]
        voter3 = signers[4]
        approvedAffiliate = signers[5]
        prospectAffiliate = signers[6]
        outsider = signers[7]
        signing1 = signers[8]
        signing2 = signers[9]

        advertPOLFactoryFacet = await ethers.getContractAt("OpenAdvertsAdvertPOLFactoryFacet", deployedAddresses.diamond)
        advertUSDCFactoryFacet = await ethers.getContractAt("OpenAdvertsAdvertUSDCFactoryFacet", deployedAddresses.diamond)
        advertisersFacet = await ethers.getContractAt("OpenAdvertsAdvertisersFacet", deployedAddresses.diamond)
        affiliatesFacet = await ethers.getContractAt("OpenAdvertsAffiliatesFacet", deployedAddresses.diamond)
        affiliatesVotingFacet = await ethers.getContractAt("OpenAdvertsAffiliatesVotingFacet", deployedAddresses.diamond)
        tokenFacet = await ethers.getContractAt("OpenAdvertsTokenFacet", deployedAddresses.diamond)

        diamondAddress = deployedAddresses.diamond
        gateSigner = await gate.installGateSigner(diamondAddress, owner)

        const usdcAddress = await advertisersFacet.getUSDCTokenAddress()
        mockUSDC = await ethers.getContractAt("MockUSDC", usdcAddress)

        await tokenFacet.connect(owner).transfer(voter1.address, ethers.parseEther("100000"))
        await tokenFacet.connect(owner).transfer(voter2.address, ethers.parseEther("100000"))
        await tokenFacet.connect(owner).transfer(voter3.address, ethers.parseEther("100000"))

        await mockUSDC.connect(owner).mint(advertiser.address, ethers.parseUnits("10000", 6))
        await mockUSDC.connect(advertiser).approve(deployedAddresses.diamond, ethers.parseUnits("10000", 6))

        await createAndApproveAffiliate(approvedAffiliate, signing1.address)
        approvedAffiliateAddress = approvedAffiliate.address

        await affiliatesFacet.connect(prospectAffiliate).createProspectAffiliateContract(
            prospectAffiliate.address,
            prospectAffiliate.address,
            signing2.address,
            "prospect-aff-storage",
            ...(await gate.affiliate(gateSigner, diamondAddress, prospectAffiliate.address)))
    })

    it("stores designatedAffiliate for POL advert in contract and diamond", async function () {
        const tx = await advertPOLFactoryFacet.connect(advertiser).createNewProspectPOLAdvertContract(
            "pol-designated-1",
            BOUNTY_POL,
            1,
            approvedAffiliateAddress,
            ...(await gate.pol(gateSigner, diamondAddress, advertiser.address)),
            { value: INITIAL_FUNDING_POL }
        )
        const receipt = await tx.wait()
        const event = receipt.logs.find((log) => {
            try {
                const parsed = advertPOLFactoryFacet.interface.parseLog(log)
                return parsed.name === "POLAdvertisementCreatedAndValidated"
            } catch {
                return false
            }
        })
        const parsedEvent = advertPOLFactoryFacet.interface.parseLog(event)
        const advertAddress = parsedEvent.args.advertContract

        const advertPOLContract = await ethers.getContractAt("OpenAdvertsAdvertPOL", advertAddress)
        expect(await advertPOLContract.designatedAffiliate()).to.equal(approvedAffiliateAddress)

        const [advertDetails] = await advertisersFacet.getAdvertisementDetailsAndStatus(advertAddress)
        expect(advertDetails.designatedAffiliate).to.equal(approvedAffiliateAddress)
    })

    it("stores designatedAffiliate for USDC advert in contract and diamond", async function () {
        const tx = await advertUSDCFactoryFacet.connect(advertiser).createNewProspectUSDCAdvertContract(
            "usdc-designated-1",
            BOUNTY_USDC,
            1,
            approvedAffiliateAddress,
            FUNDING_USDC,
            ...(await gate.usdc(gateSigner, diamondAddress, advertiser.address)))
        const receipt = await tx.wait()
        const event = receipt.logs.find((log) => {
            try {
                const parsed = advertUSDCFactoryFacet.interface.parseLog(log)
                return parsed.name === "USDCAdvertCreated"
            } catch {
                return false
            }
        })
        const parsedEvent = advertUSDCFactoryFacet.interface.parseLog(event)
        const advertAddress = parsedEvent.args.advert

        const advertUSDCContract = await ethers.getContractAt("OpenAdvertsAdvertUSDC", advertAddress)
        expect(await advertUSDCContract.designatedAffiliate()).to.equal(approvedAffiliateAddress)

        const [advertDetails] = await advertisersFacet.getAdvertisementDetailsAndStatus(advertAddress)
        expect(advertDetails.designatedAffiliate).to.equal(approvedAffiliateAddress)
    })

    it("rejects non-existent and non-approved designated affiliates", async function () {
        await expect(
            advertPOLFactoryFacet.connect(advertiser).createNewProspectPOLAdvertContract(
                "pol-bad-affiliate-1",
                BOUNTY_POL,
                1,
                outsider.address,
                ...(await gate.pol(gateSigner, diamondAddress, advertiser.address)),
                { value: INITIAL_FUNDING_POL }
            )
        ).to.be.revertedWith("Designated affiliate does not exist")

        await expect(
            advertPOLFactoryFacet.connect(advertiser).createNewProspectPOLAdvertContract(
                "pol-bad-affiliate-2",
                BOUNTY_POL,
                1,
                prospectAffiliate.address,
                ...(await gate.pol(gateSigner, diamondAddress, advertiser.address)),
                { value: INITIAL_FUNDING_POL }
            )
        ).to.be.revertedWith("Designated affiliate must be Approved")
    })
})
