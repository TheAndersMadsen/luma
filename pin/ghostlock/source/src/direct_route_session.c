#include "direct_route_session.h"

#include <errno.h>
#include <limits.h>

_Static_assert(
    GHOSTLOCK_DIRECT_ROUTE_BASE_OFF +
            GHOSTLOCK_DIRECT_ROUTE_SLOTS * GHOSTLOCK_DIRECT_ROUTE_STRIDE <=
        GHOSTLOCK_DIRECT_TASK_OFF,
    "direct route slots overlap the shared fake task");
_Static_assert(
    GHOSTLOCK_DIRECT_TASK_OFF + GHOSTLOCK_DIRECT_TASK_SPAN <=
        GHOSTLOCK_DIRECT_PAGE_SIZE,
    "direct fake task exceeds the retained order-3 page");
_Static_assert(
    GHOSTLOCK_DIRECT_LOCK_SIZE + GHOSTLOCK_DIRECT_WAITER_SIZE <=
        GHOSTLOCK_DIRECT_ROUTE_STRIDE,
    "direct route stride cannot hold one lock and waiter");

int ghostlock_direct_route_layout(
    uintptr_t page, unsigned int slot,
    struct ghostlock_direct_route_layout *layout) {
  if (!layout || slot >= GHOSTLOCK_DIRECT_ROUTE_SLOTS ||
      page > UINTPTR_MAX - GHOSTLOCK_DIRECT_PAGE_SIZE) {
    errno = slot >= GHOSTLOCK_DIRECT_ROUTE_SLOTS ? ERANGE : EINVAL;
    return 0;
  }

  uintptr_t lock = page + GHOSTLOCK_DIRECT_ROUTE_BASE_OFF +
                   (uintptr_t)slot * GHOSTLOCK_DIRECT_ROUTE_STRIDE;
  layout->lock = lock;
  layout->waiter = lock + GHOSTLOCK_DIRECT_LOCK_SIZE;
  layout->task = page + GHOSTLOCK_DIRECT_TASK_OFF;
  return 1;
}

int ghostlock_direct_route_claim(_Atomic unsigned int *cursor) {
  if (!cursor) {
    errno = EINVAL;
    return -1;
  }
  unsigned int slot = atomic_fetch_add_explicit(
      cursor, 1U, memory_order_relaxed);
  if (slot >= GHOSTLOCK_DIRECT_ROUTE_SLOTS || slot > (unsigned int)INT_MAX) {
    errno = ENOSPC;
    return -1;
  }
  return (int)slot;
}
