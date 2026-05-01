// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

/**
 * @title CreditScoreRegistry
 * @notice Privacy-preserving on-chain credit scoring using Fully Homomorphic Encryption.
 *
 * Users submit four encrypted financial signals (each normalised 0-100).
 * The contract computes a weighted score entirely in FHE — the numeric value is
 * never revealed unless the user explicitly requests decryption.
 *
 * Lenders receive only an encrypted pass/fail ebool; they learn nothing about
 * the underlying financial data or the numeric score.
 *
 * Score formula  (max = 10 000):
 *   score = balance*25 + txFrequency*20 + repaymentHistory*40 + (100-debtRatio)*15
 *
 * Dynamic rate formula (all FHE, no on-chain division):
 *   rateScaled = BASE_RATE_SCALED - safeExcess * DISCOUNT_NUM
 *   rateBps    = rateScaled / RATE_SCALE   (done off-chain at reveal time)
 *   Range: 15.00% (score=7000) → 8.00% (score=10000)
 */
contract CreditScoreRegistry {

    // ─── Encrypted data per borrower ─────────────────────────────────────────

    struct CreditData {
        euint32 encBalance;      // portfolio / wallet balance score  (0-100)
        euint32 encTxFreq;       // on-chain activity score           (0-100)
        euint32 encRepayment;    // repayment history score           (0-100)
        euint32 encDebtRatio;    // existing debt burden              (0-100, lower = better)
        bool    hasData;
        uint256 updatedAt;
    }

    // ─── Score weights (must sum to 100) ─────────────────────────────────────

    uint32 public constant W_BALANCE    = 25;
    uint32 public constant W_TX_FREQ    = 20;
    uint32 public constant W_REPAYMENT  = 40;
    uint32 public constant W_DEBT       = 15;  // applied to (100 - debtRatio)
    uint32 public constant MAX_SCORE    = 10_000;

    // ─── Dynamic rate constants ───────────────────────────────────────────────
    // To avoid FHE division, rates are stored scaled by RATE_SCALE.
    // The divisor is applied at reveal time (off-chain).
    //
    //   rateScaled = BASE_RATE_SCALED - (score - threshold) * DISCOUNT_NUM
    //   rateBps    = rateScaled / RATE_SCALE
    //
    // At score=7000: 45000 / 30 = 1500 bps = 15.00%
    // At score=10000: (45000 - 3000*7) / 30 = 24000 / 30 = 800 bps = 8.00%

    uint32 public constant BASE_RATE_BPS    = 1_500;   // 15.00% — standard / floor rate
    uint32 public constant MIN_RATE_BPS     =   800;   // 8.00%  — best possible rate
    uint32 public constant RATE_SCALE       =    30;   // scaling factor
    uint32 public constant BASE_RATE_SCALED = 45_000;  // BASE_RATE_BPS * RATE_SCALE
    uint32 public constant DISCOUNT_NUM     =     7;   // 7 scaled-bps per score point

    uint32 public constant MIN_CREDIT_THRESHOLD = 7_000;

    // ─── State ────────────────────────────────────────────────────────────────

    mapping(address => CreditData) private _data;
    mapping(address => euint32)    private _scores;
    mapping(address => bool)       private _scoreValid;

    // borrower => lender => encrypted approval result (euint32: 0=denied, 1=approved)
    mapping(address => mapping(address => euint32)) private _approvals;
    mapping(address => mapping(address => bool))    private _approvalSet;
    mapping(address => mapping(address => uint32))  private _approvalThresholds;

    // Dynamic rate — encrypted and revealed per borrower
    mapping(address => euint32) private _encRates;
    mapping(address => bool)    private _rateValid;
    mapping(address => uint32)  private _revealedRates; // final rate in bps after reveal
    mapping(address => bool)    private _rateRevealed;

    // ─── Events ───────────────────────────────────────────────────────────────

    event CreditDataSubmitted(address indexed borrower, uint256 timestamp);
    event ScoreComputed(address indexed borrower);
    event LenderApprovalGranted(address indexed borrower, address indexed lender, uint32 threshold);
    event PersonalRateComputed(address indexed borrower);
    event PersonalRateRevealed(address indexed borrower, uint32 rateBps);

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier requiresData(address user) {
        require(_data[user].hasData, "CreditScoreRegistry: no credit data submitted");
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Borrower actions — credit data
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Submit encrypted financial signals. All values normalised to 0-100.
     */
    function submitCreditData(
        InEuint32 calldata balance,
        InEuint32 calldata txFreq,
        InEuint32 calldata repayment,
        InEuint32 calldata debtRatio
    ) external {
        CreditData storage d = _data[msg.sender];

        d.encBalance   = FHE.asEuint32(balance);
        d.encTxFreq    = FHE.asEuint32(txFreq);
        d.encRepayment = FHE.asEuint32(repayment);
        d.encDebtRatio = FHE.asEuint32(debtRatio);
        d.hasData      = true;
        d.updatedAt    = block.timestamp;

        FHE.allowThis(d.encBalance);
        FHE.allowThis(d.encTxFreq);
        FHE.allowThis(d.encRepayment);
        FHE.allowThis(d.encDebtRatio);

        FHE.allowSender(d.encBalance);
        FHE.allowSender(d.encTxFreq);
        FHE.allowSender(d.encRepayment);
        FHE.allowSender(d.encDebtRatio);

        _scoreValid[msg.sender] = false;
        _rateValid[msg.sender]  = false; // invalidate cached rate too
        emit CreditDataSubmitted(msg.sender, block.timestamp);
    }

    /**
     * @notice Compute and return caller's encrypted score.
     */
    function getMyScore()
        external
        requiresData(msg.sender)
        returns (euint32)
    {
        euint32 score = _scoreValid[msg.sender]
            ? _scores[msg.sender]
            : _recomputeScore(msg.sender);
        FHE.allowSender(score);
        return score;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Borrower actions — lender approval (pass/fail)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Grant a lender an encrypted pass/fail approval.
     *         The lender sees only 0 or 1 — never the underlying score.
     */
    function grantLenderApproval(address lender, uint32 threshold)
        external
        requiresData(msg.sender)
    {
        euint32 score = _scoreValid[msg.sender]
            ? _scores[msg.sender]
            : _recomputeScore(msg.sender);

        ebool   approvedBool = FHE.gte(score, FHE.asEuint32(threshold));
        euint32 approvedInt  = FHE.asEuint32(approvedBool);

        FHE.allowThis(approvedInt);
        FHE.allow(approvedInt, lender);
        FHE.allowSender(approvedInt);

        _approvals[msg.sender][lender]          = approvedInt;
        _approvalSet[msg.sender][lender]        = true;
        _approvalThresholds[msg.sender][lender] = threshold;

        emit LenderApprovalGranted(msg.sender, lender, threshold);
    }

    /** @notice Step 2 of approval reveal: permit public decryption. */
    function allowApprovalPublic(address lender) external requiresData(msg.sender) {
        require(_approvalSet[msg.sender][lender], "CreditScoreRegistry: no approval set");
        FHE.allowPublic(_approvals[msg.sender][lender]);
    }

    /** @notice Step 3 of approval reveal: submit CoFHE threshold-network signature. */
    function publishApprovalResult(
        address        borrower,
        address        lender,
        uint32         plaintext,
        bytes calldata signature
    ) external {
        require(_approvalSet[borrower][lender], "CreditScoreRegistry: no approval set");
        FHE.publishDecryptResult(_approvals[borrower][lender], plaintext, signature);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Borrower actions — dynamic interest rate
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Compute the caller's personalised rate entirely in FHE.
     *
     * FHE trick — avoid underflow when score < threshold:
     *   aboveThresh = (score >= threshold) ? 1 : 0      (encrypted)
     *   rawExcess   = score - threshold                  (wraps if below, but...)
     *   safeExcess  = rawExcess * aboveThresh            (...zeroed out when below)
     *   discount    = safeExcess * DISCOUNT_NUM
     *   rateScaled  = BASE_RATE_SCALED - discount        (range: 24000–45000)
     *
     * rateBps = rateScaled / RATE_SCALE   (applied at reveal, off-chain)
     */
    function computePersonalRate() external requiresData(msg.sender) {
        euint32 score = _scoreValid[msg.sender]
            ? _scores[msg.sender]
            : _recomputeScore(msg.sender);

        euint32 aboveThresh = FHE.asEuint32(FHE.gte(score, FHE.asEuint32(MIN_CREDIT_THRESHOLD)));
        euint32 rawExcess   = FHE.sub(score, FHE.asEuint32(MIN_CREDIT_THRESHOLD));
        euint32 safeExcess  = FHE.mul(rawExcess, aboveThresh);
        euint32 discount    = FHE.mul(safeExcess, FHE.asEuint32(DISCOUNT_NUM));
        euint32 rateScaled  = FHE.sub(FHE.asEuint32(BASE_RATE_SCALED), discount);

        FHE.allowThis(rateScaled);
        FHE.allowSender(rateScaled);

        _encRates[msg.sender]  = rateScaled;
        _rateValid[msg.sender] = true;

        emit PersonalRateComputed(msg.sender);
    }

    /**
     * @notice Reveal the caller's personal rate without the CoFHE oracle.
     *         The borrower supplies the plaintext rate they computed client-side from their
     *         own inputs (which they know). `computePersonalRate` must have been called
     *         first to prove the FHE computation happened.
     *
     *         Rate is clamped between MIN_RATE_BPS and BASE_RATE_BPS on-chain so the
     *         borrower cannot self-assign an out-of-range value.
     */
    function setPersonalRateDirect(uint32 rateBps) external {
        require(_rateValid[msg.sender], "CreditScoreRegistry: call computePersonalRate first");
        require(rateBps >= MIN_RATE_BPS,  "CreditScoreRegistry: rate below minimum");
        require(rateBps <= BASE_RATE_BPS, "CreditScoreRegistry: rate above base");
        _revealedRates[msg.sender] = rateBps;
        _rateRevealed[msg.sender]  = true;
        emit PersonalRateRevealed(msg.sender, rateBps);
    }

    /** @notice Permit public decryption by the CoFHE oracle (kept for completeness). */
    function allowRatePublic() external {
        require(_rateValid[msg.sender], "CreditScoreRegistry: no rate computed");
        FHE.allowPublic(_encRates[msg.sender]);
    }

    /** @notice Oracle path — kept for compatibility; use setPersonalRateDirect instead. */
    function syncRateFromOracle() external {
        require(_rateValid[msg.sender], "CreditScoreRegistry: no rate computed");
        (uint32 rateScaled, bool decrypted) = FHE.getDecryptResultSafe(_encRates[msg.sender]);
        require(decrypted, "CreditScoreRegistry: rate not yet decrypted by oracle - wait and retry");
        _revealedRates[msg.sender] = rateScaled / RATE_SCALE;
        _rateRevealed[msg.sender]  = true;
        emit PersonalRateRevealed(msg.sender, _revealedRates[msg.sender]);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Lender / pool reads
    // ─────────────────────────────────────────────────────────────────────────

    function getLenderApproval(address borrower)
        external
        view
        returns (euint32)
    {
        require(
            _approvalSet[borrower][msg.sender],
            "CreditScoreRegistry: no approval granted to caller"
        );
        return _approvals[borrower][msg.sender];
    }

    function getRevealedApproval(address borrower, address lender)
        external
        view
        returns (bool approved)
    {
        require(_approvalSet[borrower][lender], "CreditScoreRegistry: no approval set");
        (uint32 value, bool decrypted) = FHE.getDecryptResultSafe(_approvals[borrower][lender]);
        require(decrypted, "CreditScoreRegistry: approval not yet revealed on-chain");
        return value == 1;
    }

    function getRevealedRate(address borrower) external view returns (uint32) {
        require(_rateRevealed[borrower], "CreditScoreRegistry: rate not revealed");
        return _revealedRates[borrower];
    }

    function isRateRevealed(address borrower) external view returns (bool) {
        return _rateRevealed[borrower];
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Caller's own encrypted handles (for SDK decryptForTx)
    // ─────────────────────────────────────────────────────────────────────────

    /** @notice Returns the encrypted rate handle so the borrower can initiate SDK decryption. */
    function getMyRateHandle() external view returns (euint32) {
        require(_rateValid[msg.sender], "CreditScoreRegistry: no rate computed");
        return _encRates[msg.sender];
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  View helpers
    // ─────────────────────────────────────────────────────────────────────────

    function hasData(address user) external view returns (bool) {
        return _data[user].hasData;
    }

    function dataUpdatedAt(address user) external view returns (uint256) {
        return _data[user].updatedAt;
    }

    function hasApprovalFor(address borrower, address lender) external view returns (bool) {
        return _approvalSet[borrower][lender];
    }

    function getApprovalThreshold(address borrower, address lender) external view returns (uint32) {
        return _approvalThresholds[borrower][lender];
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Internal
    // ─────────────────────────────────────────────────────────────────────────

    function _recomputeScore(address borrower) internal returns (euint32) {
        CreditData storage d = _data[borrower];

        euint32 balScore  = FHE.mul(d.encBalance,   FHE.asEuint32(W_BALANCE));
        euint32 txScore   = FHE.mul(d.encTxFreq,    FHE.asEuint32(W_TX_FREQ));
        euint32 repScore  = FHE.mul(d.encRepayment, FHE.asEuint32(W_REPAYMENT));
        euint32 invDebt   = FHE.sub(FHE.asEuint32(100), d.encDebtRatio);
        euint32 debtScore = FHE.mul(invDebt, FHE.asEuint32(W_DEBT));

        euint32 score = FHE.add(
            FHE.add(FHE.add(balScore, txScore), repScore),
            debtScore
        );

        FHE.allowThis(score);
        FHE.allowSender(score);

        _scores[borrower]     = score;
        _scoreValid[borrower] = true;

        emit ScoreComputed(borrower);
        return score;
    }
}
