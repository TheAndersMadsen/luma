#include "kaslr_proof.h"

#include <errno.h>
#include <stdlib.h>

int ghostlock_parse_bugreport_kaslr(
    const char *value, uint64_t image_base, uint64_t alignment,
    uint64_t max_slide, uint64_t *base_out, uint64_t *slide_out) {
  if (!value || !*value || !base_out || !slide_out || alignment == 0 ||
      (alignment & (alignment - 1)) != 0 || max_slide == 0) {
    return 0;
  }

  errno = 0;
  char *end = NULL;
  unsigned long long parsed = strtoull(value, &end, 0);
  if (errno || end == value || !end || *end || parsed < image_base) {
    return 0;
  }

  uint64_t base = (uint64_t)parsed;
  uint64_t slide = base - image_base;
  if (slide >= max_slide || (slide & (alignment - 1)) != 0) {
    return 0;
  }

  *base_out = base;
  *slide_out = slide;
  return 1;
}
