#ifndef MARGIN_NATIVE_POSIX_H
#define MARGIN_NATIVE_POSIX_H

#include <dirent.h>
#include <errno.h>
#include <limits.h>
#include <node_api.h>
#include <stdbool.h>
#include <string.h>
#include <sys/file.h>
#include <unistd.h>
#include "lock.h"

static napi_value number(napi_env env, int n) {
  napi_value value;
  napi_create_int32(env, n, &value);
  return value;
}

static bool get_path(napi_env env, napi_value value, char path[PATH_MAX]) {
  size_t length, copied;
  return napi_get_value_string_utf8(env, value, NULL, 0, &length) == napi_ok &&
    length < PATH_MAX &&
    napi_get_value_string_utf8(env, value, path, PATH_MAX, &copied) == napi_ok &&
    strlen(path) == copied;
}

static napi_value entries(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1], result;
  int fd;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 1 || napi_get_value_int32(env, args[0], &fd) != napi_ok) return number(env, -EINVAL);

  int copy = dup(fd);
  if (copy < 0) return number(env, -errno);
  DIR *directory = fdopendir(copy);
  if (!directory) {
    int error = errno;
    close(copy);
    return number(env, -error);
  }
  napi_create_array(env, &result);
  uint32_t index = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(directory);
    if (!entry) {
      int error = errno;
      closedir(directory);
      return error ? number(env, -error) : result;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    const char *kind = entry->d_type == DT_DIR ? "directory" : "file";
    if (entry->d_type != DT_DIR && entry->d_type != DT_REG) continue;
    napi_value name, type, item;
    napi_create_array_with_length(env, 2, &item);
    napi_create_buffer_copy(env, strlen(entry->d_name), entry->d_name, NULL, &name);
    napi_create_string_utf8(env, kind, NAPI_AUTO_LENGTH, &type);
    napi_set_element(env, item, 0, name);
    napi_set_element(env, item, 1, type);
    napi_set_element(env, result, index++, item);
  }
}

static napi_value file_lock(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2], result;
  int fd, operation;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 2 || napi_get_value_int32(env, args[0], &fd) != napi_ok ||
      napi_get_value_int32(env, args[1], &operation) != napi_ok ||
      operation < FILE_LOCK_UNLOCK || operation > FILE_LOCK_EXCLUSIVE) {
    return number(env, -EINVAL);
  }
  int flags = operation == FILE_LOCK_UNLOCK ? LOCK_UN
    : LOCK_NB | (operation == FILE_LOCK_SHARED ? LOCK_SH : LOCK_EX);
  bool locked = flock(fd, flags) == 0;
  if (!locked && errno != EWOULDBLOCK) return number(env, -errno);
  napi_get_boolean(env, locked, &result);
  return result;
}

static napi_value change_directory(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  int fd;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 1 || napi_get_value_int32(env, args[0], &fd) != napi_ok) return number(env, -EINVAL);
  return number(env, fchdir(fd) == 0 ? 0 : -errno);
}

#endif
