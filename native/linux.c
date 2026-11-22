#include <fcntl.h>
#include <linux/magic.h>
#include <linux/openat2.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <sys/xattr.h>
#include "posix.h"

static int resolved_open(int directory, const char *path, unsigned int flags, unsigned int resolve) {
  struct open_how how = { .flags = flags, .resolve = resolve };
  return syscall(SYS_openat2, directory, path, &how, sizeof(how));
}

static bool local_ext4(int fd) {
  struct statfs fs;
  struct statx st;
  if (fstatfs(fd, &fs) != 0 || fs.f_type != EXT4_SUPER_MAGIC ||
      statx(fd, "", AT_EMPTY_PATH, STATX_MNT_ID, &st) != 0 || !(st.stx_mask & STATX_MNT_ID)) return false;

  FILE *mounts = fopen("/proc/self/mountinfo", "re");
  if (!mounts) return false;
  char *line = NULL;
  size_t capacity = 0;
  bool match = false;
  unsigned int full_mounts = 0;
  while (getline(&line, &capacity, mounts) != -1) {
    unsigned long long id;
    unsigned int major, minor;
    int root = 0;
    if (sscanf(line, "%llu %*u %u:%u %n", &id, &major, &minor, &root) != 3 || !root ||
        major != st.stx_dev_major || minor != st.stx_dev_minor || strncmp(line + root, "/ ", 2) != 0) continue;

    const char *type = strstr(line + root, " - ");
    if (!type || strncmp(type, " - ext4 ", 8) != 0) continue;

    // A second mount of the whole volume is indistinguishable from a bind mount.
    full_mounts++;
    if (id == st.stx_mnt_id) match = true;
  }
  bool safe = !ferror(mounts) && match && full_mounts == 1;
  free(line);
  fclose(mounts);
  return safe;
}

static ssize_t path_from_fd(int fd, char path[PATH_MAX]) {
  char link[64];
  snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
  ssize_t length = readlink(link, path, PATH_MAX);
  if (length < 0) return -errno;
  if (length == PATH_MAX) return -ENAMETOOLONG;
  if (length == 0 || path[0] != '/') return -EINVAL;
  path[length] = '\0';
  return length;
}

static napi_value open_directory(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  char path[PATH_MAX];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 1 || !get_path(env, args[0], path) || path[0] != '/') return number(env, -EINVAL);

  int fd = resolved_open(AT_FDCWD, path, O_RDONLY | O_DIRECTORY | O_CLOEXEC, RESOLVE_NO_SYMLINKS);
  if (fd < 0) return number(env, -errno);
  if (!local_ext4(fd)) {
    close(fd);
    return number(env, -ENOTSUP);
  }
  return number(env, fd);
}

static bool matching_path(int fd, int root, const char *relative) {
  char root_path[PATH_MAX], entry_path[PATH_MAX];
  ssize_t length = path_from_fd(root, root_path);
  if (length < 0 || path_from_fd(fd, entry_path) <= length) return false;
  if (length == 1) return strcmp(entry_path + 1, relative) == 0;
  return strncmp(entry_path, root_path, length) == 0 && entry_path[length] == '/' &&
    strcmp(entry_path + length + 1, relative) == 0;
}

static napi_value open_entry(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  char path[PATH_MAX];
  int root_fd;
  bool directory;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 4 || napi_get_value_int32(env, args[0], &root_fd) != napi_ok ||
      !get_path(env, args[1], path) ||
      napi_get_value_bool(env, args[2], &directory) != napi_ok) return number(env, -EINVAL);

  int flags = O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOCTTY | (directory ? O_DIRECTORY : 0);
  int fd = resolved_open(root_fd, path, flags, RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV);
  if (fd < 0) return number(env, -errno);
  struct stat st;
  if (fstat(fd, &st) != 0 || !matching_path(fd, root_fd, path) ||
      (directory ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode) || st.st_nlink != 1)) {
    close(fd);
    return number(env, -EINVAL);
  }
  return number(env, fd);
}

static bool no_acl(int fd, const char *attribute) {
  return fgetxattr(fd, attribute, NULL, 0) < 0 && errno == ENODATA;
}

static napi_value private_access(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2], result;
  int fd;
  bool ancestor;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 2 || napi_get_value_int32(env, args[0], &fd) != napi_ok ||
      napi_get_value_bool(env, args[1], &ancestor) != napi_ok) return number(env, -EINVAL);

  struct stat st;
  uid_t user = geteuid();
  bool safe = fstat(fd, &st) == 0 && local_ext4(fd) && no_acl(fd, "system.posix_acl_access") &&
    (!S_ISDIR(st.st_mode) || no_acl(fd, "system.posix_acl_default")) &&
    (ancestor
     ? S_ISDIR(st.st_mode) && (st.st_uid == 0 || st.st_uid == user) &&
       ((st.st_mode & 0022) == 0 || (st.st_mode & S_ISVTX) != 0)
     : st.st_uid == user && (st.st_mode & 0077) == 0 &&
       (S_ISDIR(st.st_mode) || (S_ISREG(st.st_mode) && st.st_nlink == 1)));
  napi_get_boolean(env, safe, &result);
  return result;
}

static napi_value entry_path(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1], result;
  int fd;
  char path[PATH_MAX];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 1 || napi_get_value_int32(env, args[0], &fd) != napi_ok) return number(env, -EINVAL);
  ssize_t length = path_from_fd(fd, path);
  if (length < 0) return number(env, length);
  napi_create_string_utf8(env, path, length, &result);
  return result;
}

static napi_value publish(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  char from[PATH_MAX], to[PATH_MAX];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 2 || !get_path(env, args[0], from) || !get_path(env, args[1], to)) return number(env, -EINVAL);
  return number(env, renameat2(AT_FDCWD, from, AT_FDCWD, to, RENAME_NOREPLACE) == 0 ? 0 : -errno);
}

NAPI_MODULE_INIT() {
  const napi_property_descriptor methods[] = {
    { .utf8name = "openDirectory", .method = open_directory },
    { .utf8name = "openEntry", .method = open_entry },
    { .utf8name = "entries", .method = entries },
    { .utf8name = "privateAccess", .method = private_access },
    { .utf8name = "entryPath", .method = entry_path },
    { .utf8name = "changeDirectory", .method = change_directory },
    { .utf8name = "fileLock", .method = file_lock },
    { .utf8name = "publish", .method = publish }
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}
