#include "kaslr_proof.h"

#include <assert.h>
#include <stdint.h>
#include <stdio.h>

int main(void) {
  const uint64_t image_base = UINT64_C(0xffffff8008080000);
  const uint64_t alignment = UINT64_C(0x200000);
  const uint64_t max_slide = UINT64_C(1) << 37;
  uint64_t base = 0;
  uint64_t slide = 0;

  assert(ghostlock_parse_bugreport_kaslr(
      "0xffffff9f85880000", image_base, alignment, max_slide,
      &base, &slide));
  assert(base == UINT64_C(0xffffff9f85880000));
  assert(slide == base - image_base);

  assert(!ghostlock_parse_bugreport_kaslr(
      NULL, image_base, alignment, max_slide, &base, &slide));
  assert(!ghostlock_parse_bugreport_kaslr(
      "", image_base, alignment, max_slide, &base, &slide));
  assert(!ghostlock_parse_bugreport_kaslr(
      "0xffffff9f85880000junk", image_base, alignment, max_slide,
      &base, &slide));
  assert(!ghostlock_parse_bugreport_kaslr(
      "0xffffff9f85881000", image_base, alignment, max_slide,
      &base, &slide));
  assert(!ghostlock_parse_bugreport_kaslr(
      "0xffffff8007e80000", image_base, alignment, max_slide,
      &base, &slide));
  assert(!ghostlock_parse_bugreport_kaslr(
      "0xfffffffffffffffe", image_base, alignment, max_slide,
      &base, &slide));
  assert(!ghostlock_parse_bugreport_kaslr(
      "18446744073709551616", image_base, alignment, max_slide,
      &base, &slide));

  puts("kaslr proof tests passed");
  return 0;
}
