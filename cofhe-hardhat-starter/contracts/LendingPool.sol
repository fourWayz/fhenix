// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "./CreditScoreRegistry.sol";

/**
 * @title LendingPool
 */
contract LendingPool {
    CreditScoreRegistry public immutable registry;

    uint256 public constant STANDARD_RATIO       = 150;    // % collateral, no credit
    uint256 public constant CREDIT_RATIO         = 110;    // % collateral, credit-approved
    uint32  public constant MIN_CREDIT_THRESHOLD = 7_000;  // out of 10 000
    uint32  public constant BASE_RATE_BPS        = 1_500;  // 15.00 % APR (standard)

    struct Loan {
        uint256 principal;
        uint256 collateral;
        bool    creditApproved;
        bool    active;
        uint256 issuedAt;
        uint32  interestRateBps; // annual rate in basis points (e.g. 1200 = 12.00 %)
    }

    mapping(address => Loan)    public loans;
    mapping(address => uint256) public providerDeposits;

    uint256 public totalDeposited;
    uint256 public totalBorrowed;

    // ─── Events ───────────────────────────────────────────────────────────────

    event Deposited(address indexed provider, uint256 amount);
    event Withdrawn(address indexed provider, uint256 amount);
    event LoanIssued(address indexed borrower, uint256 principal, bool creditApproved, uint256 collateral, uint32 interestRateBps);
    event LoanRepaid(address indexed borrower, uint256 principal, uint256 interest);

    constructor(address _registry) {
        registry = CreditScoreRegistry(_registry);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Liquidity providers
    // ─────────────────────────────────────────────────────────────────────────

    function deposit() external payable {
        require(msg.value > 0, "LendingPool: zero deposit");
        providerDeposits[msg.sender] += msg.value;
        totalDeposited               += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        require(providerDeposits[msg.sender] >= amount, "LendingPool: insufficient deposit");
        require(availableLiquidity() >= amount,         "LendingPool: insufficient liquidity");
        providerDeposits[msg.sender] -= amount;
        totalDeposited               -= amount;
        payable(msg.sender).transfer(amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Borrowers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Request a loan. Supply at least `collateralRequired()` ETH as msg.value.
     *
     * When useCredit=true: requires both on-chain approval reveal AND rate reveal
     * from the registry (full 6-step credit flow above).
     */
    function requestLoan(uint256 principal, bool useCredit) external payable {
        require(principal > 0,             "LendingPool: zero principal");
        require(!loans[msg.sender].active, "LendingPool: active loan exists");
        require(availableLiquidity() >= principal, "LendingPool: insufficient liquidity");

        uint256 ratio;
        uint32  rateBps;

        if (useCredit) {
            bool approved = registry.getRevealedApproval(msg.sender, address(this));
            require(approved, "LendingPool: credit score below threshold");

            uint32 usedThreshold = registry.getApprovalThreshold(msg.sender, address(this));
            require(
                usedThreshold >= MIN_CREDIT_THRESHOLD,
                "LendingPool: approval threshold too low"
            );

            require(registry.isRateRevealed(msg.sender), "LendingPool: personal rate not revealed - complete credit flow first");
            rateBps = registry.getRevealedRate(msg.sender);
            ratio   = CREDIT_RATIO;
        } else {
            rateBps = BASE_RATE_BPS;
            ratio   = STANDARD_RATIO;
        }

        uint256 required = (principal * ratio) / 100;
        require(msg.value >= required, "LendingPool: insufficient collateral");

        loans[msg.sender] = Loan({
            principal:       principal,
            collateral:      msg.value,
            creditApproved:  useCredit,
            active:          true,
            issuedAt:        block.timestamp,
            interestRateBps: rateBps
        });

        totalBorrowed += principal;
        payable(msg.sender).transfer(principal);

        emit LoanIssued(msg.sender, principal, useCredit, msg.value, rateBps);
    }

    /**
     * @notice Repay the active loan in full (principal + accrued interest).
     *         Send at least `totalRepaymentDue(msg.sender)` as msg.value.
     *         Any overpayment is refunded. Collateral is returned on repayment.
     */
    function repayLoan() external payable {
        Loan storage loan = loans[msg.sender];
        require(loan.active, "LendingPool: no active loan");

        uint256 interest = getAccruedInterest(msg.sender);
        uint256 totalDue = loan.principal + interest;
        require(msg.value >= totalDue, "LendingPool: send principal + accrued interest");

        uint256 principal  = loan.principal;
        uint256 collateral = loan.collateral;
        totalBorrowed -= principal;
        delete loans[msg.sender];

        // Refund any overpayment
        if (msg.value > totalDue) {
            payable(msg.sender).transfer(msg.value - totalDue);
        }
        payable(msg.sender).transfer(collateral);

        emit LoanRepaid(msg.sender, principal, interest);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Views
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Accrued interest for an active loan.
     *         interest = principal × rateBps × elapsed / (10_000 × 365 days)
     */
    function getAccruedInterest(address borrower) public view returns (uint256) {
        Loan storage loan = loans[borrower];
        if (!loan.active) return 0;
        uint256 elapsed = block.timestamp - loan.issuedAt;
        return (loan.principal * loan.interestRateBps * elapsed) / (10_000 * 365 days);
    }

    /** @notice Total amount (principal + interest) required to repay right now. */
    function totalRepaymentDue(address borrower) external view returns (uint256) {
        Loan storage loan = loans[borrower];
        if (!loan.active) return 0;
        return loan.principal + getAccruedInterest(borrower);
    }

    function availableLiquidity() public view returns (uint256) {
        uint256 bal = address(this).balance;
        return bal > totalBorrowed ? bal - totalBorrowed : 0;
    }

    function poolBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function collateralRequired(uint256 principal, bool useCredit)
        external
        pure
        returns (uint256)
    {
        uint256 ratio = useCredit ? CREDIT_RATIO : STANDARD_RATIO;
        return (principal * ratio) / 100;
    }

    receive() external payable {}
}
