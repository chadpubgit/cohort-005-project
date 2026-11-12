# Approving a refund deletes the enrollment

When an admin approves a Refund Request, the learner loses access to the course at that moment. We do this by deleting their `enrollments` row in the same transaction that resolves the request, unless another purchase without an approved refund, or a redeemed team seat, still gives them access. Lesson progress and watch history are kept. Access is checked in `getAccess` and in several copies of `isUserEnrolled` across routes, so treating "has an enrollment row" as the only meaning of access keeps every existing check correct without touching any of them. The history of what happened lives on the purchase and its refund rows, not on the enrollment.

## Considered Options

- **A revoked-at column on enrollments**: rejected. It needs a migration, and every enrollment check would have to learn to ignore revoked rows. Missing a single check would let a refunded learner keep access.
- **Looking it up from the refund**: rejected. Every access check would need to join purchases to refunds, which has the same risk of missing a check.

## Consequences

- A refunded learner drops out of instructor student lists and enrollment counts.
- If the learner buys the course again, a new enrollment is created and their old progress shows up again.
- When an approval is for a team purchase, its unused seat codes are deleted so they can't be redeemed.
